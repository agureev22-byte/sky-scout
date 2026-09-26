// Небесный разведчик — живая карта неба.
// Режимы: «Вручную» (крутить пальцем), «Датчики» (водить телефоном), «AR» (поверх камеры).

import { View, DEG, enu, altAz, angleBetween } from './view.js';
import { Sky, loadCatalog, starName, BODIES } from './scene.js';
import { Renderer } from './render.js';
import {
  OrientationTracker, orientationSupported, needsPermission, requestOrientationPermission,
} from './orientation.js';
import { startCamera, stopCamera, videoFocal, cameraSupported } from './camera.js';
import { bodyCard, starCard, satCard, altText, whenText } from './info.js';
import { magneticDeclination } from './geomag.js';
import {
  loadSatellites, makeObserver as satObserver, frameContext, satPosition, track, findPasses, tleAgeDays, TLE_GROUPS,
} from '../satellites.js';
import {
  getSavedLocation, saveLocation, requestPosition, searchPlaces, parseCoords, distanceKm,
} from '../location.js';
import { makeFormatter, deviceTimeZone, formatCoords, escapeHtml as esc, direction8, decimal } from '../format.js';
import { storage } from '../storage.js';
import { initTheme, updateNight, getThemeMode, setThemeMode } from '../theme.js';

const $ = (id) => document.getElementById(id);
const MIN = 60000;
const HOUR = 60 * MIN;

const DEFAULT_LAYERS = {
  stars: true, constellations: true, labels: true, planets: true, satellites: true, starlink: true, grid: false,
};

const settings = {
  layers: { ...DEFAULT_LAYERS, ...(storage.get('layers-v1') || {}) },
  mode: storage.get('mode-v1') || 'manual',
  compassOffset: Number(storage.get('compass-offset-v1')) || 0,
  arFov: Number(storage.get('ar-fov-v1')) || 63,
  manual: storage.get('manual-view-v1') || { az: 180, alt: 35, fov: 100 },
};

function saveSettings() {
  storage.set('layers-v1', settings.layers);
  storage.set('mode-v1', settings.mode === 'ar' ? 'sensors' : settings.mode);
  storage.set('compass-offset-v1', settings.compassOffset);
  storage.set('ar-fov-v1', settings.arFov);
  storage.set('manual-view-v1', settings.manual);
}

const state = {
  location: null,
  declination: 0,
  timeOffset: 0,
  cat: null,
  sats: [],
  satPos: [],
  satT: [],
  satPrev: [],
  satSources: null,
  satLoading: false,
  importantIdx: [],
  starlinkIdx: [],
  rr: 0,
  selection: null,
  tails: [],
  tailsAt: 0,
  dirty: true,
  lastDraw: 0,
  calibrating: false,
  fmt: makeFormatter(deviceTimeZone()),
};

const view = new View();
const sky = new Sky();
const tracker = new OrientationTracker({ onChange: () => (state.dirty = true) });
const canvas = $('sky');
const renderer = new Renderer(canvas);
const video = $('camera');
let satObs = null;

const skyTime = () => Date.now() + state.timeOffset;

// ---------- размеры ----------

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  view.resize(w, h);
  renderer.resize(w, h, Math.min(window.devicePixelRatio || 1, 3));
  state.dirty = true;
}

// ---------- место ----------

function setLocation(loc, save = true) {
  state.location = loc;
  if (save) saveLocation(loc);
  sky.setObserver(loc.lat, loc.lon, Number.isFinite(loc.elevation) ? loc.elevation : 0);
  satObs = satObserver(loc.lat, loc.lon, Number.isFinite(loc.elevation) ? loc.elevation : 0);
  try {
    state.declination = magneticDeclination(loc.lat, loc.lon, 0, new Date());
  } catch {
    state.declination = 0;
  }
  state.satT = new Array(state.sats.length).fill(0);
  state.satPos = new Array(state.sats.length).fill(null);
  state.satPrev = new Array(state.sats.length).fill(null);
  if (state.selection && state.selection.type === 'sat') {
    state.selection.passes = null;
    state.selection.trackAt = 0;
  }
  renderPlace();
  state.dirty = true;
}

function renderPlace() {
  const loc = state.location;
  $('place-name').textContent = !loc ? 'Выбрать место' : loc.source === 'gps' ? 'Моё место' : loc.name || 'Точка';
}

// ---------- спутники ----------

function onSatellites({ sats, sources }) {
  const prevSel = state.selection && state.selection.type === 'sat' ? state.selection.id : null;
  state.sats = sats;
  state.satSources = sources;
  state.satPos = new Array(sats.length).fill(null);
  state.satT = new Array(sats.length).fill(0);
  state.satPrev = new Array(sats.length).fill(null);
  state.importantIdx = [];
  state.starlinkIdx = [];
  sats.forEach((s, i) => (s.group === 'starlink' ? state.starlinkIdx : state.importantIdx).push(i));
  if (prevSel !== null) {
    const idx = sats.findIndex((s) => s.id === prevSel);
    if (idx >= 0) state.selection.index = idx;
    else state.selection = null;
  }
  state.dirty = true;
  renderSatStatus();
}

async function refreshSatellites(force = false) {
  if (state.satLoading) return;
  state.satLoading = true;
  renderSatStatus();
  try {
    await loadSatellites({ force, onUpdate: onSatellites });
  } catch (err) {
    console.warn('Спутники недоступны', err);
  } finally {
    state.satLoading = false;
    renderSatStatus();
  }
}

let lastSatFrame = 0;

function updateSatPositions(ms) {
  if (!satObs || !state.sats.length || !settings.layers.satellites) return;
  const date = new Date(ms);
  const ctx = frameContext(date);
  const { sats, satPos, satT } = state;
  for (const i of state.importantIdx) {
    satPos[i] = satPosition(sats[i], date, satObs, ctx);
    satT[i] = ms;
  }
  if (settings.layers.starlink && state.starlinkIdx.length) {
    // Тысячи Starlink считаем по кругу порциями: весь круг — примерно за 1,5 с,
    // а между пересчётами положение продлеваем по скорости (см. visibleSatPositions).
    const list = state.starlinkIdx;
    const nowWall = performance.now();
    const dt = Math.min(250, Math.max(8, nowWall - (lastSatFrame || nowWall - 16)));
    lastSatFrame = nowWall;
    const chunk = Math.min(list.length, Math.ceil((list.length * dt) / 1500));
    const prev = state.satPrev;
    for (let k = 0; k < chunk; k++) {
      state.rr = (state.rr + 1) % list.length;
      const i = list[state.rr];
      const old = satPos[i];
      const oldT = satT[i];
      const pos = satPosition(sats[i], date, satObs, ctx);
      prev[i] = old && pos && ms - oldT > 0 && ms - oldT < 5000 ? { alt: old.alt, az: old.az, t: oldT } : null;
      satPos[i] = pos;
      satT[i] = ms;
    }
  }
}

// Позиции для рисования. Starlink между пересчётами продлеваем по скорости,
// а посчитанные для совсем другого времени (после прокрутки шкалы) — не показываем.
function visibleSatPositions(ms) {
  const { satPos, satT, sats, satPrev } = state;
  const showStarlink = settings.layers.starlink;
  const out = new Array(satPos.length);
  for (let i = 0; i < satPos.length; i++) {
    const p = satPos[i];
    if (!p || sats[i].group !== 'starlink') {
      out[i] = p;
      continue;
    }
    const age = ms - satT[i];
    if (!showStarlink || Math.abs(age) > 4000) {
      out[i] = null;
      continue;
    }
    const q = satPrev[i];
    if (q && age !== 0) {
      const span = satT[i] - q.t;
      const k = age / span;
      let dAz = p.az - q.az;
      if (dAz > 180) dAz -= 360;
      if (dAz < -180) dAz += 360;
      out[i] = { ...p, alt: p.alt + (p.alt - q.alt) * k, az: (p.az + dAz * k + 360) % 360 };
    } else out[i] = p;
  }
  return out;
}

function updateTails(ms) {
  if (!satObs || Math.abs(ms - state.tailsAt) < 5000) return;
  state.tailsAt = ms;
  state.tails = [];
  state.sats.forEach((s, i) => {
    if (!s.featured) return;
    const pos = state.satPos[i];
    if (!pos || pos.alt < -5) return;
    state.tails.push({ points: track(s, satObs, ms, ms + 5 * MIN, 20) });
  });
}

// ---------- выбор объекта ----------

function select(hit) {
  if (!hit) {
    state.selection = null;
    hideCard();
    state.dirty = true;
    return;
  }
  if (hit.type === 'body') {
    const b = sky.body(hit.id);
    state.selection = { type: 'body', id: hit.id, name: b.name };
  } else if (hit.type === 'star') {
    const name = state.cat ? starName(state.cat, hit.index) : null;
    state.selection = { type: 'star', index: hit.index, name: name || 'Звезда' };
  } else if (hit.type === 'sat') {
    const s = state.sats[hit.index];
    state.selection = { type: 'sat', index: hit.index, id: s.id, name: s.name, trackAt: 0, passes: null };
  }
  updateSelection(skyTime());
  renderCard(true);
  state.dirty = true;
}

function updateSelection(ms) {
  const sel = state.selection;
  if (!sel) return;
  if (sel.type === 'body') {
    sel.vec = sky.body(sel.id).vec;
  } else if (sel.type === 'star' && sky.starEnu) {
    const e = sky.starEnu;
    sel.vec = [e[3 * sel.index], e[3 * sel.index + 1], e[3 * sel.index + 2]];
  } else if (sel.type === 'sat') {
    const sat = state.sats[sel.index];
    if (!sat || !satObs) return;
    const pos = satPosition(sat, new Date(ms), satObs, frameContext(new Date(ms)));
    sel.pos = pos;
    sel.vec = pos ? enu(pos.alt, pos.az) : null;
    // Пролёты считаем на 5 дней вперёд и пересчитываем, только когда время ушло за этот диапазон.
    if (!sel.passes || ms < sel.passesFrom - MIN || ms > sel.passesFrom + 3 * 24 * HOUR) {
      sel.passes = findPasses(sat, satObs, { from: ms - 15 * MIN, days: 5, minAlt: 10, maxPasses: 16 });
      sel.passesFrom = ms;
    }
    // траектория: текущий пролёт или ближайший будущий
    if (!sel.track || Math.abs(ms - sel.trackAt) > 30000 || ms < sel.trackFrom || ms > sel.trackTo) {
      let from = ms - 12 * MIN;
      let to = ms + 12 * MIN;
      if (pos && pos.alt < 0) {
        const next = sel.passes.find((p) => p.set.t > ms);
        if (next) {
          from = next.rise.t - MIN;
          to = next.set.t + MIN;
        }
      }
      const pts = track(sat, satObs, from, to, 15);
      for (const pt of pts) {
        const minuteMark = Math.round(pt.t / MIN) * MIN;
        if (Math.abs(pt.t - minuteMark) < 7500) {
          pt.tick = true;
          const m = new Date(minuteMark).getMinutes();
          if (m % 2 === 0) pt.label = state.fmt.time(minuteMark);
        }
      }
      sel.track = pts;
      sel.trackAt = ms;
      sel.trackFrom = Math.min(from, ms - 12 * MIN);
      sel.trackTo = to;
    }
  }
}

// ---------- карточка ----------

let cardTimer = 0;

function renderCard(force = false) {
  const sel = state.selection;
  if (!sel) return;
  const now = skyTime();
  if (!force && performance.now() - cardTimer < 1000) return;
  cardTimer = performance.now();
  const fmt = state.fmt;
  let card;
  try {
    if (sel.type === 'body') card = bodyCard(sky, sky.body(sel.id), fmt, now, state.cat);
    else if (sel.type === 'star') card = starCard(sky, state.cat, sel.index, fmt, now);
    else if (sel.type === 'sat') {
      const sat = state.sats[sel.index];
      const group = TLE_GROUPS.find((g) => g.id === sat.group);
      const visible = (sel.passes || []).filter((p) => p.visible && p.set.t > now).slice(0, 5);
      const all = (sel.passes || []).filter((p) => p.set.t > now);
      card = satCard(sat, sel.pos, fmt, now, {
        passes: visible.length ? visible : all.slice(0, 3),
        ageDays: tleAgeDays(sat, now),
        groupTitle: group ? group.title : '',
      });
      card.passTitle = visible.length ? 'Видимые пролёты' : all.length ? 'Ближайшие пролёты (не видны глазом)' : null;
      card.passEmpty = !all.length ? 'Пролётов выше 10° в ближайшие 5 дней нет.' : null;
    }
  } catch (err) {
    console.error(err);
    return;
  }
  const el = $('card');
  const scroll = el.scrollTop;
  el.hidden = false;
  el.innerHTML = `
    <div class="card-head">
      <div>
        <h2>${esc(card.title)}</h2>
        ${card.subtitle ? `<p class="card-sub">${esc(card.subtitle)}</p>` : ''}
      </div>
      <button class="round" id="card-close" type="button" aria-label="Закрыть">✕</button>
    </div>
    <dl class="rows">${card.rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
    ${card.note ? `<p class="card-note">${esc(card.note)}</p>` : ''}
    ${card.passTitle ? `<h3>${esc(card.passTitle)}</h3>
      <ul class="passes">${card.passes.map((p) => `<li class="${p.visible ? 'vis' : ''}"><b>${esc(p.when)}</b><span>${esc(p.path)}</span></li>`).join('')}</ul>` : ''}
    ${card.passEmpty ? `<p class="card-note">${esc(card.passEmpty)}</p>` : ''}
    <div class="card-actions">
      ${settings.mode === 'manual' ? '<button class="btn" id="card-center" type="button">Навести</button>' : ''}
    </div>
  `;
  el.scrollTop = scroll;
  $('card-close').addEventListener('click', () => select(null));
  const c = $('card-center');
  if (c) c.addEventListener('click', () => centerOn(state.selection));
}

function hideCard() {
  $('card').hidden = true;
  $('card').innerHTML = '';
}

// Навести ручную карту на объект. Если открыта карточка — ставим объект над ней, а не в центр.
function centerOn(sel) {
  if (!sel || !sel.vec || settings.mode !== 'manual') return;
  const { az, alt } = altAz(sel.vec);
  const card = $('card');
  let shift = 0;
  if (!card.hidden) {
    const top = card.getBoundingClientRect().top;
    const targetY = Math.max(110, (90 + top) / 2);
    shift = (view.height / 2 - targetY) * (view.effectiveFov / Math.min(view.width, view.height));
  }
  animateTo(az, Math.max(-90, Math.min(90, alt - shift)));
}

let anim = null;
function animateTo(az, alt) {
  const from = { ...settings.manual };
  let dAz = ((az - from.az + 540) % 360) - 180;
  const t0 = performance.now();
  anim = (now) => {
    const k = Math.min(1, (now - t0) / 600);
    const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
    settings.manual.az = (from.az + dAz * e + 360) % 360;
    settings.manual.alt = from.alt + (alt - from.alt) * e;
    if (k >= 1) {
      anim = null;
      saveSettings();
    }
  };
}

// ---------- режимы ----------

const MODE_NAMES = { manual: 'Вручную', sensors: 'Датчики', ar: 'AR' };

async function setMode(mode, { fromGesture = false } = {}) {
  hideBanner();
  if (mode === 'sensors' || mode === 'ar') {
    if (!orientationSupported()) {
      toast('На этом устройстве нет датчиков ориентации — остаёмся в ручном режиме.');
      mode = 'manual';
    } else if (needsPermission() && fromGesture) {
      const res = await requestOrientationPermission();
      if (res !== 'granted') {
        toast('Без разрешения на датчики карта не сможет поворачиваться за телефоном. Включите «Движение и ориентация» в настройках Safari.');
        mode = 'manual';
      }
    }
  }
  if (mode !== 'manual') tracker.start();
  if (mode === 'ar') {
    try {
      await startCamera(video);
      document.body.classList.add('ar');
    } catch (err) {
      toast(err.message);
      mode = 'sensors';
    }
  }
  if (mode !== 'ar') {
    stopCamera(video);
    document.body.classList.remove('ar');
  }
  settings.mode = mode;
  saveSettings();
  $('mode-name').textContent = MODE_NAMES[mode];
  if (state.selection) renderCard(true);
  state.dirty = true;
  if (mode !== 'manual') watchSensors();
}

// Если через пару секунд данных от датчиков нет — подсказать.
let sensorWatch = 0;
function watchSensors() {
  clearTimeout(sensorWatch);
  sensorWatch = setTimeout(() => {
    if (settings.mode === 'manual' || tracker.active) return;
    if (needsPermission()) showBanner('Нажмите, чтобы включить датчики движения', () => setMode(settings.mode, { fromGesture: true }));
    else showBanner('Датчики не отвечают. Перейти в ручной режим?', () => setMode('manual'));
  }, 1800);
}

function applyView(ms) {
  if (settings.mode === 'manual' || !tracker.active) {
    view.projection = 'stereo';
    view.focalOverride = null;
    view.fov = settings.manual.fov;
    view.lookAt(settings.manual.az, settings.manual.alt);
    return;
  }
  const axes = tracker.axes(state.declination, settings.compassOffset);
  if (axes) view.setAxes(axes.r, axes.u, axes.f);
  if (settings.mode === 'ar') {
    view.projection = 'gnomonic';
    view.focalOverride = videoFocal(video, view.width, view.height, settings.arFov);
  } else {
    view.projection = 'stereo';
    view.focalOverride = null;
    view.fov = settings.manual.fov;
  }
}

// ---------- кадр ----------

function frame(now) {
  requestAnimationFrame(frame);
  if (anim) {
    anim(now);
    state.dirty = true;
  }
  const live = settings.mode !== 'manual' && tracker.active;
  const interval = live ? 0 : state.sats.length ? 100 : 1000;
  if (!state.dirty && now - state.lastDraw < interval) return;
  if (!state.location) return;
  state.dirty = false;
  state.lastDraw = now;
  const ms = skyTime();
  sky.update(ms);
  if (state.cat) sky.transformStars(state.cat);
  updateSatPositions(ms);
  updateTails(ms);
  applyView(ms);
  updateSelection(ms);
  updateNight(sky.sunAlt);
  renderer.draw({
    view,
    sky,
    cat: state.cat,
    starEnu: sky.starEnu,
    sats: state.sats,
    satPos: visibleSatPositions(ms),
    tails: settings.layers.satellites ? state.tails : null,
    layers: settings.layers,
    theme: document.documentElement.dataset.theme === 'red' ? 'red' : 'dark',
    mode: settings.mode === 'manual' || !tracker.active ? 'manual' : settings.mode,
    selection: state.selection,
    insets: { top: 90, bottom: 150 },
  });
  renderTime(ms);
  renderCenterHint();
  renderCard();
}

// ---------- время ----------

function renderTime(ms) {
  const fmt = state.fmt;
  $('time-main').textContent = fmt.time(ms);
  $('time-date').textContent = `${fmt.weekdayShort(ms)}, ${fmt.dayMonth(ms)}`;
  const off = state.timeOffset;
  const offEl = $('time-offset');
  const nowBtn = $('now-btn');
  document.body.classList.toggle('shifted', Math.abs(off) >= 30000);
  if (Math.abs(off) < 30000) {
    offEl.textContent = 'сейчас';
    nowBtn.classList.remove('active');
  } else {
    const sign = off > 0 ? '+' : '−';
    const a = Math.abs(off);
    const d = Math.floor(a / (24 * HOUR));
    const h = Math.floor((a % (24 * HOUR)) / HOUR);
    const m = Math.round((a % HOUR) / MIN);
    const parts = [];
    if (d) parts.push(`${d} д`);
    if (h) parts.push(`${h} ч`);
    if (m || !parts.length) parts.push(`${m} мин`);
    offEl.textContent = `${sign}${parts.join(' ')}`;
    nowBtn.classList.add('active');
  }
}

function shiftTime(delta) {
  state.timeOffset += delta;
  state.dirty = true;
  cardTimer = 0; // карточка обновится в ближайшем кадре
}

function setNow() {
  state.timeOffset = 0;
  state.dirty = true;
  cardTimer = 0;
}

// «В центре»: подсказка, что сейчас под прицелом (в режимах датчиков).
let centerHintAt = 0;
function renderCenterHint() {
  const el = $('center-hint');
  if (settings.mode === 'manual' || !tracker.active) {
    el.hidden = true;
    return;
  }
  const now = performance.now();
  if (now - centerHintAt < 250) return;
  centerHintAt = now;
  const h = renderer.hitTest(view.width / 2, view.height / 2, 26);
  if (!h) {
    const c = view.center;
    el.hidden = false;
    el.textContent = `${Math.round(c.az) % 360}° ${direction8(c.az).short} · высота ${Math.round(c.alt)}°`;
    return;
  }
  el.hidden = false;
  el.textContent = hitName(h);
}

function hitName(h) {
  if (h.type === 'body') return sky.body(h.id).name;
  if (h.type === 'sat') return state.sats[h.index].name;
  if (h.type === 'star') return (state.cat && starName(state.cat, h.index)) || 'Звезда';
  return '';
}

// ---------- жесты ----------

const pointers = new Map();
let gesture = null;

function onPointerDown(e) {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) {
    gesture = { type: 'tap', x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, t0: performance.now() };
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    gesture = { type: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y), fov0: settings.manual.fov };
  }
}

function onPointerMove(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!gesture) return;
  if (gesture.type === 'pinch' && pointers.size === 2) {
    if (settings.mode === 'ar') return;
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    settings.manual.fov = Math.max(20, Math.min(150, (gesture.fov0 * gesture.d0) / Math.max(20, d)));
    state.dirty = true;
    return;
  }
  const dx = e.clientX - gesture.x;
  const dy = e.clientY - gesture.y;
  if (gesture.type === 'tap' && Math.hypot(e.clientX - gesture.x0, e.clientY - gesture.y0) > 8) gesture.type = 'drag';
  if (gesture.type !== 'drag') return;
  gesture.x = e.clientX;
  gesture.y = e.clientY;
  const degPerPx = view.effectiveFov / Math.min(view.width, view.height);
  if (settings.mode === 'manual' || !tracker.active) {
    anim = null;
    settings.manual.az = (settings.manual.az - dx * degPerPx + 360) % 360;
    settings.manual.alt = Math.max(-90, Math.min(90, settings.manual.alt + dy * degPerPx));
    state.dirty = true;
  } else if (state.calibrating) {
    settings.compassOffset = ((settings.compassOffset - dx * degPerPx + 540) % 360) - 180;
    $('calib-value').textContent = `${settings.compassOffset > 0 ? '+' : ''}${decimal(settings.compassOffset, 1)}°`;
    state.dirty = true;
  }
}

function onPointerUp(e) {
  pointers.delete(e.pointerId);
  if (gesture && gesture.type === 'tap' && pointers.size === 0) {
    const hit = renderer.hitTest(e.clientX, e.clientY);
    select(hit);
  }
  if (pointers.size === 0) {
    if (gesture && gesture.type !== 'tap') saveSettings();
    gesture = null;
  }
}

function onWheel(e) {
  if (settings.mode === 'ar') return;
  e.preventDefault();
  settings.manual.fov = Math.max(20, Math.min(150, settings.manual.fov * Math.exp(e.deltaY * 0.001)));
  state.dirty = true;
}

// ---------- листы: место, режим, настройки, поиск ----------

function openSheet(id) {
  document.querySelectorAll('.sheet-backdrop').forEach((s) => (s.hidden = s.id !== id));
}

function closeSheets() {
  document.querySelectorAll('.sheet-backdrop').forEach((s) => (s.hidden = true));
}

let searchTimer = 0;
let searchCtrl = null;

function bindPlaceSheet() {
  $('place-btn').addEventListener('click', () => {
    $('place-error').hidden = true;
    openSheet('place-sheet');
  });
  $('place-locate').addEventListener('click', () => locate(true));
  $('search-input').addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = $('search-input').value;
    if (q.trim().length < 2) {
      $('search-results').innerHTML = '';
      return;
    }
    searchTimer = setTimeout(async () => {
      if (searchCtrl) searchCtrl.abort();
      searchCtrl = new AbortController();
      const list = $('search-results');
      list.innerHTML = '<li class="muted">Ищу…</li>';
      try {
        const found = await searchPlaces(q, { signal: searchCtrl.signal });
        if (!found.length) {
          list.innerHTML = '<li class="muted">Ничего не нашлось. Попробуйте иначе или введите координаты.</li>';
          return;
        }
        list.innerHTML = found
          .map((p, i) => `<li><button type="button" data-i="${i}"><b>${esc(p.name)}</b><span>${esc(p.region)}</span></button></li>`)
          .join('');
        list.querySelectorAll('button').forEach((b) =>
          b.addEventListener('click', () => {
            const p = found[Number(b.dataset.i)];
            setLocation({ ...p, updatedAt: Date.now() });
            closeSheets();
            finishWelcome();
          }),
        );
      } catch (err) {
        if (err.name !== 'AbortError') {
          list.innerHTML = `<li class="muted">${navigator.onLine === false ? 'Нет связи — поиск не работает. Введите координаты.' : 'Поиск не удался, попробуйте ещё раз.'}</li>`;
        }
      }
    }, 350);
  });
  const useCoords = () => {
    const c = parseCoords($('coords-input').value);
    if (!c) {
      $('place-error').hidden = false;
      $('place-error').textContent = 'Не понял координаты. Пример: 41.39, 2.17 (широта, долгота).';
      return;
    }
    setLocation({ ...c, elevation: null, name: formatCoords(c.lat, c.lon), source: 'manual', updatedAt: Date.now() });
    closeSheets();
    finishWelcome();
  };
  $('coords-btn').addEventListener('click', useCoords);
  $('coords-input').addEventListener('keydown', (e) => e.key === 'Enter' && useCoords());
}

async function locate(fromSheet) {
  const btn = fromSheet ? $('place-locate') : null;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Определяю…';
  }
  try {
    const pos = await requestPosition({ highAccuracy: false });
    setLocation(pos);
    if (fromSheet) closeSheets();
    return true;
  } catch (err) {
    if (fromSheet) {
      $('place-error').hidden = false;
      $('place-error').textContent = err.message;
    } else {
      $('place-error').hidden = false;
      $('place-error').textContent = err.message;
      openSheet('place-sheet');
    }
    return false;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Определить моё место';
    }
  }
}

function bindModeSheet() {
  $('mode-btn').addEventListener('click', () => openSheet('mode-sheet'));
  document.querySelectorAll('[data-mode]').forEach((b) =>
    b.addEventListener('click', () => {
      closeSheets();
      setMode(b.dataset.mode, { fromGesture: true });
    }),
  );
  if (!cameraSupported()) $('mode-ar').disabled = true;
}

function renderSettings() {
  document.querySelectorAll('[data-layer]').forEach((inp) => {
    inp.checked = !!settings.layers[inp.dataset.layer];
  });
  document.querySelectorAll('[data-theme-mode]').forEach((b) => b.classList.toggle('on', b.dataset.themeMode === getThemeMode()));
  $('ar-fov').value = settings.arFov;
  $('ar-fov-value').textContent = `${settings.arFov}°`;
  const d = state.declination;
  const comp = tracker.mode === 'ios'
    ? `Компас iPhone${tracker.accuracy >= 0 && tracker.accuracy !== null ? `, точность ±${Math.round(tracker.accuracy)}°` : ''}`
    : tracker.mode === 'absolute' ? 'Компас устройства' : tracker.mode === 'relative' ? 'Компаса нет — выровняйте небо вручную' : 'Датчики ещё не включены';
  $('compass-status').textContent = `${comp}. Магнитное склонение здесь ${d >= 0 ? '+' : '−'}${decimal(Math.abs(d), 1)}° — учтено. Ручная поправка ${settings.compassOffset > 0 ? '+' : ''}${decimal(settings.compassOffset, 1)}°.`;
  renderSatStatus();
}

function renderSatStatus() {
  const el = $('sat-status');
  if (!el) return;
  const src = state.satSources;
  if (state.satLoading && !state.sats.length) {
    el.textContent = 'Загружаю орбиты спутников…';
    return;
  }
  if (!src) {
    el.textContent = 'Данных о спутниках пока нет.';
    return;
  }
  const parts = [];
  let oldest = null;
  let errors = 0;
  for (const g of TLE_GROUPS) {
    const s = src[g.id];
    if (!s) continue;
    if (s.fetchedAt && (!oldest || s.fetchedAt < oldest)) oldest = s.fetchedAt;
    if (s.error && !s.count) errors++;
    if (s.count) parts.push(`${g.title}: ${s.count}`);
  }
  let text = parts.length ? `${parts.join(', ')}.` : 'Спутники не загружены.';
  if (oldest) text += ` Орбиты от ${whenText(state.fmt, oldest, Date.now())}.`;
  if (errors) text += ' Часть данных получить не удалось — нужен интернет.';
  el.textContent = text;
}

function bindSettingsSheet() {
  $('menu-btn').addEventListener('click', () => {
    renderSettings();
    openSheet('settings-sheet');
  });
  document.querySelectorAll('[data-layer]').forEach((inp) =>
    inp.addEventListener('change', () => {
      settings.layers[inp.dataset.layer] = inp.checked;
      saveSettings();
      state.dirty = true;
    }),
  );
  document.querySelectorAll('[data-theme-mode]').forEach((b) =>
    b.addEventListener('click', () => {
      setThemeMode(b.dataset.themeMode);
      updateNight(sky.sunAlt);
      renderSettings();
      state.dirty = true;
    }),
  );
  $('ar-fov').addEventListener('input', () => {
    settings.arFov = Number($('ar-fov').value);
    $('ar-fov-value').textContent = `${settings.arFov}°`;
    saveSettings();
    state.dirty = true;
  });
  $('calib-start').addEventListener('click', () => {
    closeSheets();
    if (settings.mode === 'manual') {
      toast('Подстройка компаса работает в режимах «Датчики» и AR.');
      return;
    }
    state.calibrating = true;
    $('calib').hidden = false;
    $('calib-value').textContent = `${settings.compassOffset > 0 ? '+' : ''}${decimal(settings.compassOffset, 1)}°`;
  });
  $('calib-reset').addEventListener('click', () => {
    settings.compassOffset = 0;
    saveSettings();
    renderSettings();
    state.dirty = true;
  });
  $('calib-done').addEventListener('click', () => {
    state.calibrating = false;
    $('calib').hidden = true;
    saveSettings();
  });
  $('sat-refresh').addEventListener('click', () => refreshSatellites(true));
}

function bindFindSheet() {
  $('find-btn').addEventListener('click', () => {
    renderFind();
    openSheet('find-sheet');
  });
}

function renderFind() {
  const items = [];
  for (const b of sky.bodies) items.push({ type: 'body', id: b.id, name: b.name, alt: b.alt, az: b.az });
  state.sats.forEach((s, i) => {
    if (!s.featured) return;
    const p = state.satPos[i] || (satObs ? satPosition(s, new Date(skyTime()), satObs) : null);
    if (p) items.push({ type: 'sat', index: i, name: s.name, alt: p.alt, az: p.az, sunlit: p.sunlit });
  });
  const stars = [];
  if (state.cat && sky.starEnu) {
    for (const i of state.cat.named) {
      if (state.cat.mag[i] > 1.6) continue;
      const e = sky.starEnu;
      const { alt, az } = altAz([e[3 * i], e[3 * i + 1], e[3 * i + 2]]);
      stars.push({ type: 'star', index: i, name: starName(state.cat, i), alt, az });
    }
  }
  const row = (o) => `<li><button type="button" data-find='${esc(JSON.stringify({ type: o.type, id: o.id, index: o.index }))}'>
      <b>${esc(o.name)}</b><span>${esc(o.alt > -0.5 ? `${Math.round(o.alt)}° · ${direction8(o.az).nom}` : 'под горизонтом')}${o.sunlit === false && o.alt > 0 ? ' · в тени' : ''}</span></button></li>`;
  $('find-list').innerHTML = `
    <h3>Солнечная система</h3><ul class="pick">${items.filter((o) => o.type === 'body').map(row).join('')}</ul>
    ${items.some((o) => o.type === 'sat') ? `<h3>Спутники</h3><ul class="pick">${items.filter((o) => o.type === 'sat').map(row).join('')}</ul>` : ''}
    ${stars.length ? `<h3>Яркие звёзды</h3><ul class="pick">${stars.sort((a, b) => b.alt - a.alt).map(row).join('')}</ul>` : ''}
  `;
  $('find-list').querySelectorAll('[data-find]').forEach((b) =>
    b.addEventListener('click', () => {
      const h = JSON.parse(b.dataset.find);
      closeSheets();
      select(h);
      centerOn(state.selection);
    }),
  );
}

// ---------- подсказки ----------

let toastTimer = 0;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 5000);
}

let bannerAction = null;
function showBanner(text, action) {
  const el = $('banner');
  el.textContent = text;
  el.hidden = false;
  bannerAction = action;
}

function hideBanner() {
  $('banner').hidden = true;
  bannerAction = null;
}

// ---------- первый запуск ----------

function finishWelcome() {
  $('welcome').hidden = true;
  storage.set('welcome-done-v1', true);
}

function bindWelcome() {
  $('start-btn').addEventListener('click', () => {
    // На iOS разрешение на датчики — строго внутри нажатия, до любых await.
    const perm = requestOrientationPermission();
    const loc = locate(false);
    perm.then(async (res) => {
      const ok = await loc;
      const mode = res === 'granted' && orientationSupported() ? 'sensors' : 'manual';
      if (res === 'denied') toast('Без датчиков — крутите небо пальцем. Включить их можно позже кнопкой режима.');
      await setMode(mode);
      if (ok) finishWelcome();
    });
  });
  $('manual-start').addEventListener('click', async () => {
    await setMode('manual');
    const ok = await locate(false);
    if (ok) finishWelcome();
  });
}

// ---------- запуск ----------

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Офлайн-режим недоступен', err));
}

function boot() {
  initTheme();
  resize();
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 200));
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  document.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => shiftTime(Number(b.dataset.step))));
  $('now-btn').addEventListener('click', setNow);
  bindTimeScrub();
  bindPlaceSheet();
  bindModeSheet();
  bindSettingsSheet();
  bindFindSheet();
  bindWelcome();
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeSheets));
  document.querySelectorAll('.sheet-backdrop').forEach((s) => s.addEventListener('click', (e) => e.target === s && closeSheets()));
  $('banner').addEventListener('click', () => bannerAction && bannerAction());
  document.addEventListener('visibilitychange', () => {
    state.dirty = true;
    if (!document.hidden) {
      const src = state.satSources;
      const stale = !src || Object.values(src).some((s) => !s.fetchedAt || Date.now() - s.fetchedAt > 12 * HOUR);
      if (stale) refreshSatellites();
    }
  });

  loadCatalog()
    .then((cat) => {
      state.cat = cat;
      state.dirty = true;
    })
    .catch((err) => toast(`Каталог звёзд не загрузился: ${err.message}`));
  refreshSatellites();

  const saved = getSavedLocation();
  if (saved) setLocation(saved, false);
  if (saved && storage.get('welcome-done-v1')) {
    $('welcome').hidden = true;
    setMode(settings.mode);
  } else {
    $('welcome').hidden = false;
  }
  $('mode-name').textContent = MODE_NAMES[settings.mode];
  registerServiceWorker();
  requestAnimationFrame(frame);
}

// Прокрутка времени пальцем по шкале: 1 пиксель ≈ 1 минута, быстрый жест — часы.
function bindTimeScrub() {
  const el = $('time-display');
  let last = null;
  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture(e.pointerId);
    last = { x: e.clientX, t: performance.now() };
  });
  el.addEventListener('pointermove', (e) => {
    if (!last) return;
    const dx = e.clientX - last.x;
    const dt = Math.max(1, performance.now() - last.t);
    const speed = Math.abs(dx) / dt; // пикселей в мс
    const perPx = speed > 1.2 ? 20 * MIN : speed > 0.5 ? 5 * MIN : MIN;
    if (dx !== 0) shiftTime(Math.round(dx * perPx));
    last = { x: e.clientX, t: performance.now() };
  });
  const end = () => (last = null);
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

boot();

// Для отладки и автотестов.
window.__sky = { state, settings, view, sky, tracker, renderer, select, setMode, skyTime, BODIES, angleBetween };
