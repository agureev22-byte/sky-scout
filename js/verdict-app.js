// Небесный разведчик — экран «вердикт на сегодня».
// Порядок: место → мгновенный расчёт по кэшу → засветка и свежий прогноз в фоне → перерисовка.

import { evaluateNights } from './nights.js';
import { buildVerdict } from './verdict.js';
import { makeFormatter, formatCoords, escapeHtml as esc } from './format.js';
import { getForecast, loadCachedForecast } from './weather.js';
import { loadCities, estimateLightPollution } from './lightpollution.js';
import {
  getSavedLocation, saveLocation, requestPosition, geolocationPermission, searchPlaces, parseCoords, distanceKm,
} from './location.js';
import { initTheme, cycleThemeMode, updateNight, themeLabel } from './theme.js';
import {
  ICONS, renderLoading, renderVerdict, renderNext, renderTimeline, renderObjects, renderFactors, renderWeek,
} from './render.js';

const $ = (id) => document.getElementById(id);

const state = {
  location: null,
  weather: null,
  weatherError: null,
  weatherLoading: false,
  light: null,
  lastRender: 0,
};

// ---------- вычисление и отрисовка ----------

function recompute() {
  const loc = state.location;
  if (!loc) return;
  const now = Date.now();
  const fmt = makeFormatter(loc.timezone || (state.weather && state.weather.timezone));
  let verdict;
  let result;
  try {
    result = evaluateNights({
      lat: loc.lat,
      lon: loc.lon,
      elevation: Number.isFinite(loc.elevation) ? loc.elevation : state.weather?.elevation ?? 0,
      now,
      weather: state.weather,
    });
    verdict = buildVerdict({ result, now, fmt, light: state.light, weather: state.weather });
  } catch (err) {
    console.error(err);
    const el = $('verdict');
    el.className = 'card verdict tone-unknown';
    el.innerHTML = `<p class="status">Что-то пошло не так при расчёте.</p><p>${esc(err.message || String(err))}</p>`;
    return;
  }
  state.lastRender = now;
  updateNight(result.sunAltNow);
  updateThemeButton();

  const south = loc.lat < 0;
  renderVerdict($('verdict'), verdict);
  renderNext($('next'), verdict.next);
  renderTimeline($('timeline'), verdict.timeline);
  renderObjects($('objects'), verdict.objects, south);
  renderFactors($('factors'), verdict.factors, south);
  renderWeek($('week'), verdict.week, south);
  renderForecastNote(verdict, fmt);
}

function renderForecastNote(verdict, fmt) {
  const el = $('forecast-note');
  const parts = [];
  let stale = false;
  if (state.weatherLoading && !state.weather) parts.push('Загружаю прогноз облачности…');
  else if (verdict.forecastNote) {
    parts.push(`${verdict.forecastNote.text}.`);
    stale = verdict.forecastNote.stale;
  }
  if (state.weatherError) {
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    parts.push(offline ? 'Нет связи — показываю сохранённый прогноз.' : 'Свежий прогноз получить не удалось.');
    if (!state.weather) parts.push('Вердикт посчитан только по Луне и Солнцу.');
    stale = true;
  }
  if (state.light) parts.push(`Засветка оценена приблизительно (${state.light.bortle} из 9 по шкале Бортля).`);
  el.textContent = parts.join(' ');
  el.classList.toggle('stale', stale);
}

// ---------- место ----------

function renderPlace() {
  const loc = state.location;
  const name = $('place-name');
  const sub = $('place-sub');
  if (!loc) {
    name.textContent = 'Место не выбрано';
    sub.textContent = 'нажмите, чтобы выбрать';
    return;
  }
  if (loc.source === 'gps') {
    name.textContent = 'Моё местоположение';
    sub.textContent = formatCoords(loc.lat, loc.lon);
  } else {
    name.textContent = loc.name || 'Выбранная точка';
    sub.textContent = loc.region || formatCoords(loc.lat, loc.lon);
  }
}

function showScreen() {
  $('intro').hidden = true;
  $('screen').hidden = false;
}

function showIntro(error) {
  $('intro').hidden = false;
  $('screen').hidden = true;
  const e = $('intro-error');
  e.hidden = !error;
  e.textContent = error || '';
}

async function setLocation(loc, { save = true } = {}) {
  const prev = state.location;
  state.location = loc;
  if (save) saveLocation(loc);
  renderPlace();
  showScreen();
  const moved = !prev || distanceKm(prev, loc) > 1;
  if (moved) {
    state.weather = loadCachedForecast(loc.lat, loc.lon);
    state.weatherError = null;
    state.light = null;
  }
  if (!state.weather) renderLoading($('verdict'));
  // Даём браузеру показать «Считаю небо…», затем считаем.
  await nextFrame();
  recompute();
  loadLight();
  loadWeather();
}

function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
}

async function loadLight() {
  const loc = state.location;
  try {
    const cities = await loadCities();
    if (state.location !== loc) return;
    state.light = estimateLightPollution(loc.lat, loc.lon, cities);
    recompute();
  } catch (err) {
    console.warn('Засветка недоступна', err);
  }
}

async function loadWeather(force = false) {
  const loc = state.location;
  if (!loc || state.weatherLoading) return;
  state.weatherLoading = true;
  setBusy(true);
  try {
    const r = await getForecast(loc.lat, loc.lon, { force });
    if (state.location !== loc) return;
    state.weather = r.data;
    state.weatherError = r.error;
    if (r.data && r.data.timezone && loc.timezone !== r.data.timezone) {
      loc.timezone = r.data.timezone;
      saveLocation(loc);
    }
  } finally {
    state.weatherLoading = false;
    setBusy(false);
  }
  recompute();
}

function setBusy(on) {
  $('refresh-btn').classList.toggle('busy', on);
}

async function locate({ fromSheet = false, quiet = false } = {}) {
  const btns = [$('locate-btn'), $('sheet-locate')];
  btns.forEach((b) => { b.disabled = true; b.textContent = 'Определяю…'; });
  try {
    const pos = await requestPosition({ highAccuracy: false });
    closeSheet();
    await setLocation(pos);
  } catch (err) {
    if (quiet) return;
    if (fromSheet) {
      $('sheet-error').hidden = false;
      $('sheet-error').textContent = err.message;
    } else if (state.location) {
      openSheet(err.message);
    } else {
      showIntro(err.message);
    }
  } finally {
    btns.forEach((b) => { b.disabled = false; b.textContent = 'Определить моё место'; });
  }
}

// Если место определялось по GPS и доступ уже разрешён — тихо уточняем его при запуске.
async function refreshGpsQuietly() {
  const loc = state.location;
  if (!loc || loc.source !== 'gps') return;
  if ((await geolocationPermission()) !== 'granted') return;
  try {
    const pos = await requestPosition({ maximumAge: 5 * 60 * 1000 });
    if (distanceKm(loc, pos) > 3) await setLocation(pos);
  } catch {
    /* остаёмся на сохранённом месте */
  }
}

// ---------- лист выбора места ----------

function openSheet(error) {
  $('sheet').hidden = false;
  $('sheet-error').hidden = !error;
  $('sheet-error').textContent = error || '';
  $('search-results').innerHTML = '';
  document.body.style.overflow = 'hidden';
}

function closeSheet() {
  $('sheet').hidden = true;
  document.body.style.overflow = '';
}

let searchTimer = null;
let searchCtrl = null;

function onSearchInput() {
  clearTimeout(searchTimer);
  const q = $('search-input').value;
  if (q.trim().length < 2) {
    $('search-results').innerHTML = '';
    return;
  }
  searchTimer = setTimeout(() => runSearch(q), 350);
}

async function runSearch(q) {
  if (searchCtrl) searchCtrl.abort();
  searchCtrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const list = $('search-results');
  list.innerHTML = '<li class="r-empty">Ищу…</li>';
  try {
    const found = await searchPlaces(q, { signal: searchCtrl ? searchCtrl.signal : undefined });
    if (!found.length) {
      list.innerHTML = '<li class="r-empty">Ничего не нашлось. Попробуйте иначе или введите координаты.</li>';
      return;
    }
    list.innerHTML = found
      .map((p, i) => `<li><button type="button" data-i="${i}">
        <span class="r-name">${esc(p.name)}</span><span class="r-region">${esc(p.region)}</span></button></li>`)
      .join('');
    list.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => {
        const p = found[Number(b.dataset.i)];
        closeSheet();
        setLocation({ ...p, updatedAt: Date.now() });
      });
    });
  } catch (err) {
    if (err.name === 'AbortError') return;
    list.innerHTML = `<li class="r-empty">${navigator.onLine === false ? 'Нет связи — поиск городов не работает. Введите координаты.' : 'Поиск не удался. Попробуйте ещё раз.'}</li>`;
  }
}

function onCoords() {
  const c = parseCoords($('coords-input').value);
  if (!c) {
    $('sheet-error').hidden = false;
    $('sheet-error').textContent = 'Не понял координаты. Пример: 41.39, 2.17 (широта, долгота).';
    return;
  }
  closeSheet();
  setLocation({ ...c, elevation: null, name: 'Точка на карте', region: formatCoords(c.lat, c.lon), source: 'manual', timezone: null, updatedAt: Date.now() });
}

// ---------- тема ----------

function updateThemeButton() {
  const b = $('theme-btn');
  b.innerHTML = ICONS.eyeRed;
  b.setAttribute('aria-label', `Тема: ${themeLabel()}. Нажмите, чтобы переключить`);
  b.title = themeLabel();
}

// ---------- запуск ----------

function bind() {
  $('place-btn').querySelector('.place-icon').innerHTML = ICONS.pin;
  $('refresh-btn').innerHTML = ICONS.refresh;
  $('sheet-close').innerHTML = ICONS.close;
  updateThemeButton();

  $('place-btn').addEventListener('click', () => openSheet());
  $('refresh-btn').addEventListener('click', () => {
    if (!state.location) return;
    loadWeather(true);
    if (state.location.source === 'gps') refreshGpsQuietly();
  });
  $('theme-btn').addEventListener('click', () => {
    cycleThemeMode();
    updateThemeButton();
  });
  $('locate-btn').addEventListener('click', () => locate());
  $('choose-btn').addEventListener('click', () => openSheet());
  $('sheet-locate').addEventListener('click', () => locate({ fromSheet: true }));
  $('sheet-close').addEventListener('click', closeSheet);
  $('sheet').addEventListener('click', (e) => {
    if (e.target === $('sheet')) closeSheet();
  });
  $('search-input').addEventListener('input', onSearchInput);
  $('coords-btn').addEventListener('click', onCoords);
  $('coords-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onCoords();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('sheet').hidden) closeSheet();
  });

  // Время идёт — пересчитываем раз в 5 минут и при возвращении в приложение.
  setInterval(() => {
    if (!document.hidden && state.location) recompute();
  }, 5 * 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !state.location) return;
    recompute();
    const w = state.weather;
    if (!w || Date.now() - w.fetchedAt > 60 * 60 * 1000) loadWeather();
  });
  window.addEventListener('online', () => {
    if (state.location && state.weatherError) loadWeather(true);
  });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Офлайн-режим недоступен', err));
}

function boot() {
  initTheme();
  bind();
  registerServiceWorker();
  const saved = getSavedLocation();
  if (saved) {
    setLocation(saved, { save: false }).then(refreshGpsQuietly);
  } else {
    renderPlace();
    showIntro();
  }
}

boot();
