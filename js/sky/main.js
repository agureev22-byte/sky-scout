// Небесный разведчик — живая карта неба.
// Режимы: «Вручную» (крутить пальцем), «Датчики» (водить телефоном), «AR» (поверх камеры).

import { View, enu, altAz, angleBetween, apparentAlt } from './view.js';
import { Sky, loadCatalog, starName, BODIES } from './scene.js';
import { Renderer } from './render.js';
import {
  OrientationTracker, orientationSupported, needsPermission, requestOrientationPermission, screenAngle,
} from './orientation.js';
import { startCamera, stopCamera, videoFocal, cameraSupported } from './camera.js';
import { bodyCard, starCard, satCard, whenText, unit } from './info.js';
import { magneticDeclination } from './geomag.js';
import {
  loadSatellites, makeObserver as satObserver, frameContext, satPosition, track, findPasses, tleAgeDays, TLE_GROUPS,
} from '../satellites.js';
import {
  getSavedLocation, saveLocation, requestPosition, searchPlaces, parseCoords, distanceKm, geolocationPermission,
} from '../location.js';
import { makeFormatter, deviceTimeZone, formatCoords, escapeHtml as esc, direction8, decimal, plural } from '../format.js';
import { storage } from '../storage.js';
import { initTheme, updateNight, getThemeMode, setThemeMode } from '../theme.js';

const $ = (id) => document.getElementById(id);
const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const DEFAULT_LAYERS = {
  stars: true, constellations: true, labels: true, planets: true, satellites: true, starlink: true, grid: false,
};

const settings = {
  layers: { ...DEFAULT_LAYERS, ...(storage.get('layers-v1') || {}) },
  mode: storage.get('mode-v1') || 'manual',
  // Ручная подстройка поверх настоящего компаса (без компаса поправка своя и не сохраняется).
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
  satHidden: [], // модули и пристыкованные корабли — рисуем только саму станцию
  satDraw: [], // переиспользуемые объекты для продлённых положений Starlink
  satVisible: [],
  lastSatMs: 0,
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
  relativeOffset: 0, // подстройка без компаса: живёт только до перезапуска датчиков
  realSunAlt: null,
  realSunAt: 0,
  seenResets: 0,
  locSeq: 0, // растёт при каждой смене места: поздний ответ GPS не перетрёт выбранный город
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
// Датчики используются, если режим не ручной и от них пришло хоть одно событие.
const sensorsLive = () => settings.mode !== 'manual' && tracker.hasData;

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
  state.locSeq++;
  state.location = loc;
  if (save) saveLocation(loc);
  sky.setObserver(loc.lat, loc.lon, Number.isFinite(loc.elevation) ? loc.elevation : 0);
  satObs = satObserver(loc.lat, loc.lon, Number.isFinite(loc.elevation) ? loc.elevation : 0);
  const d = magneticDeclination(loc.lat, loc.lon, 0, new Date());
  state.declination = Number.isFinite(d) ? d : 0;
  state.satT = new Array(state.sats.length).fill(0);
  state.satPos = new Array(state.sats.length).fill(null);
  state.satPrev = new Array(state.sats.length).fill(null);
  state.lastSatMs = 0;
  state.realSunAt = 0;
  if (state.selection && state.selection.type === 'sat') {
    Object.assign(state.selection, { passes: null, track: null, trackAt: 0 });
  }
  cardTimer = 0;
  renderPlace();
  state.dirty = true;
}

function renderPlace() {
  const loc = state.location;
  const name = !loc ? 'Выбрать место' : loc.source === 'gps' ? 'Моё место' : loc.name || 'Точка';
  $('place-name').textContent = name;
  $('place-btn').setAttribute('aria-label', `Место: ${name}. Нажмите, чтобы изменить`);
}

// При запуске уточняем сохранённую GPS-точку: человек мог уехать на сотни километров.
async function refreshGpsOnLaunch(saved) {
  if (!saved || saved.source !== 'gps') return;
  const age = Date.now() - (saved.updatedAt || 0);
  const perm = await geolocationPermission();
  if (perm === 'granted') {
    try {
      const pos = await requestPosition({ maximumAge: 10 * MIN });
      if (state.location && state.location.source === 'gps' && distanceKm(state.location, pos) > 1) setLocation(pos);
      else if (state.location && state.location.source === 'gps') saveLocation({ ...state.location, updatedAt: Date.now() });
    } catch {
      /* остаёмся на сохранённом месте */
    }
  } else if (perm !== 'denied' && age > 6 * HOUR) {
    const days = Math.round(age / DAY);
    const ago = days >= 1 ? `${days} ${plural(days, 'день', 'дня', 'дней')} назад` : 'несколько часов назад';
    showBanner('location', `Место определено ${ago}. Нажмите, чтобы обновить`, () => {
      hideBanner('location');
      locate(false);
    });
  }
}

// ---------- спутники ----------

function onSatellites({ sats, sources }) {
  const prevSel = state.selection && state.selection.type === 'sat' ? state.selection.id : null;
  state.sats = sats;
  state.satSources = sources;
  state.satPos = new Array(sats.length).fill(null);
  state.satT = new Array(sats.length).fill(0);
  state.satPrev = new Array(sats.length).fill(null);
  state.satHidden = sats.map((s) => !!s.moduleOf);
  state.satDraw = new Array(sats.length).fill(null);
  state.satVisible = new Array(sats.length).fill(null);
  state.lastSatMs = 0;
  state.importantIdx = [];
  state.starlinkIdx = [];
  sats.forEach((s, i) => (s.group === 'starlink' ? state.starlinkIdx : state.importantIdx).push(i));
  if (prevSel !== null) {
    const idx = sats.findIndex((s) => s.id === prevSel);
    if (idx >= 0) {
      // орбиты обновились — пролёты и траекторию считаем заново
      Object.assign(state.selection, { index: idx, passes: null, track: null, trackAt: 0 });
      cardTimer = 0;
    } else select(null);
  }
  state.dirty = true;
  renderSatStatus();
}

let satNoticeShown = false;

async function refreshSatellites(force = false) {
  if (state.satLoading) return;
  state.satLoading = true;
  renderSatStatus();
  try {
    const res = await loadSatellites({ force, onUpdate: onSatellites });
    const src = res && res.sources ? Object.values(res.sources) : [];
    if (force && src.some((g) => g.skippedFresh)) {
      toast('Орбиты уже свежие: CelesTrak просит скачивать их не чаще раза в два часа.');
    }
  } catch (err) {
    console.warn('Спутники недоступны', err);
  } finally {
    state.satLoading = false;
    renderSatStatus();
    if (!state.sats.length && !satNoticeShown) {
      satNoticeShown = true;
      toast(navigator.onLine === false
        ? 'Спутники не загрузились — нет интернета. Попробую снова, когда появится связь.'
        : 'Спутники пока не загрузились. Попробую ещё раз чуть позже.');
    }
    if (state.sats.length) satNoticeShown = false;
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
  hideDocked();
  const jumped = Math.abs(ms - state.lastSatMs) > 4000; // время на шкале прыгнуло
  state.lastSatMs = ms;
  if (settings.layers.starlink && state.starlinkIdx.length) {
    // Тысячи Starlink в реальном времени считаем по кругу порциями (весь круг ~1,5 с),
    // а между пересчётами продлеваем движение (см. visibleSatPositions).
    // После прыжка по шкале времени пересчитываем все сразу.
    const list = state.starlinkIdx;
    const nowWall = performance.now();
    const dt = Math.min(250, Math.max(8, nowWall - (lastSatFrame || nowWall - 16)));
    lastSatFrame = nowWall;
    const chunk = jumped ? list.length : Math.min(list.length, Math.ceil((list.length * dt) / 1500));
    const prev = state.satPrev;
    for (let k = 0; k < chunk; k++) {
      state.rr = (state.rr + 1) % list.length;
      const i = list[state.rr];
      const old = satPos[i];
      const oldT = satT[i];
      const pos = satPosition(sats[i], date, satObs, ctx);
      prev[i] = !jumped && old && pos && ms - oldT > 0 && ms - oldT < 5000 ? { alt: old.alt, az: old.az, t: oldT } : null;
      satPos[i] = pos;
      satT[i] = ms;
    }
  }
}

// Модули станций и пристыкованные корабли (Союз, Прогресс, Шэньчжоу…) летят вместе
// со станцией — рисуем только её саму.
function hideDocked() {
  const { sats, satPos, satHidden } = state;
  const stations = [];
  for (const i of state.importantIdx) {
    if (sats[i].featured && sats[i].id !== 20580 && satPos[i] && satPos[i].eci) stations.push(satPos[i].eci);
  }
  for (const i of state.importantIdx) {
    const s = sats[i];
    if (s.featured || s.group !== 'stations') continue;
    const p = satPos[i];
    let docked = !!s.moduleOf;
    if (!docked && p && p.eci) {
      for (const e of stations) {
        if (Math.hypot(p.eci.x - e.x, p.eci.y - e.y, p.eci.z - e.z) < 5) docked = true;
      }
    }
    satHidden[i] = docked;
  }
}

// Позиции для рисования. Starlink между пересчётами продлеваем по скорости (вектором,
// а не углами — у зенита азимут скачет); посчитанные для другого времени не показываем.
function visibleSatPositions(ms) {
  const { satPos, satT, sats, satPrev, satHidden, satDraw } = state;
  const showStarlink = settings.layers.starlink;
  if (state.satVisible.length !== satPos.length) state.satVisible = new Array(satPos.length);
  const out = state.satVisible;
  for (let i = 0; i < satPos.length; i++) {
    const p = satPos[i];
    if (!p || satHidden[i]) {
      out[i] = null;
      continue;
    }
    if (sats[i].group !== 'starlink') {
      out[i] = p;
      continue;
    }
    const age = ms - satT[i];
    if (!showStarlink || Math.abs(age) > 4000) {
      out[i] = null;
      continue;
    }
    const q = satPrev[i];
    if (!q || age === 0 || p.alt < -3 || p.alt > 85 || q.alt > 85) {
      out[i] = p;
      continue;
    }
    const k = age / (satT[i] - q.t);
    const a = enu(p.alt, p.az);
    const b = enu(q.alt, q.az);
    const v = [a[0] + (a[0] - b[0]) * k, a[1] + (a[1] - b[1]) * k, a[2] + (a[2] - b[2]) * k];
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    const aa = altAz([v[0] / l, v[1] / l, v[2] / l]);
    const d = satDraw[i] || (satDraw[i] = {});
    d.alt = aa.alt;
    d.az = aa.az;
    d.sunlit = p.sunlit;
    out[i] = d;
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

function select(hit, { fromTap = false } = {}) {
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
    if (!s) return;
    state.selection = { type: 'sat', index: hit.index, id: s.id, name: s.name, trackAt: 0, passes: null };
  }
  updateSelection(skyTime());
  buildCard();
  renderCard(true);
  state.dirty = true;
  // В ручном режиме объект, оказавшийся под карточкой, выводим из-под неё.
  if (fromTap && !sensorsLive()) {
    const r = cardRect();
    if (r && hit.x > r.left - 20 && hit.x < r.right + 20 && hit.y > r.top - 40) centerOn(state.selection);
  }
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
    sel.vec = pos ? enu(apparentAlt(pos.alt), pos.az) : null;
    // Пролёты — на 5 дней вперёд; пересчёт, когда время ушло больше чем на 12 ч,
    // так список всегда покрывает не меньше 4,5 суток.
    if (!sel.passes || ms < sel.passesFrom - MIN || ms > sel.passesFrom + 12 * HOUR) {
      sel.passes = findPasses(sat, satObs, { from: ms - 15 * MIN, days: 5, minAlt: 10, maxPasses: 200 })
        .map((p) => describeVisibility(sat, p));
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

// Для видимого пролёта — только та часть, когда спутник освещён, а небо тёмное:
// начало, конец и самая высокая точка в этом окне. Короче 30 с — не считаем видимым.
function describeVisibility(sat, p) {
  if (!p.visible || !p.visibleFrom || !p.visibleTo || p.visibleTo - p.visibleFrom < 30000) return { ...p, visible: false };
  const at = (t) => {
    const q = satPosition(sat, new Date(t), satObs);
    return q ? { t, alt: q.alt, az: q.az } : null;
  };
  const from = at(p.visibleFrom);
  const to = at(p.visibleTo);
  let max = p.max.t >= p.visibleFrom && p.max.t <= p.visibleTo ? p.max : null;
  if (!max) {
    for (let t = p.visibleFrom; t <= p.visibleTo; t += 10000) {
      const q = at(t);
      if (q && (!max || q.alt > max.alt)) max = q;
    }
  }
  if (!from || !to || !max) return { ...p, visible: false };
  return { ...p, vis: { from, to, max } };
}

// ---------- карточка ----------
// Каркас карточки (заголовок, кнопки) строится один раз при выборе объекта;
// раз в секунду обновляется только содержимое и только если текст изменился —
// так нажатия на ✕ и «Навести» не теряются, а прокрутка не сбрасывается.

let cardTimer = 0;
let cardBodyHtml = '';

function buildCard() {
  const el = $('card');
  el.hidden = false;
  el.scrollTop = 0;
  cardBodyHtml = '';
  $('card-body').innerHTML = '';
  $('card-center').hidden = settings.mode !== 'manual' && sensorsLive();
}

function renderCard(force = false) {
  const sel = state.selection;
  if (!sel) return;
  if (!force && performance.now() - cardTimer < 1000) return;
  cardTimer = performance.now();
  const now = skyTime();
  const fmt = state.fmt;
  let card;
  try {
    if (sel.type === 'body') card = bodyCard(sky, sky.body(sel.id), fmt, now, state.cat);
    else if (sel.type === 'star') card = starCard(sky, state.cat, sel.index, fmt, now);
    else if (sel.type === 'sat') card = satCardFor(sel, now);
  } catch (err) {
    console.error(err);
    return;
  }
  if (!card) return;
  $('card-title').textContent = card.title;
  $('card-sub').textContent = card.subtitle || '';
  const rows = (list) => `<dl class="rows">${list.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`;
  const html = `
    ${card.lead ? `<p class="card-lead">${esc(card.lead)}</p>` : ''}
    ${rows(card.rows)}
    ${card.passTitle ? `<h3>${esc(card.passTitle)}</h3>
      <ul class="passes">${card.passes.map((p) => `<li class="${p.visible ? 'vis' : ''}"><b>${esc(p.when)}</b><span>${esc(p.path)}</span></li>`).join('')}</ul>` : ''}
    ${card.passEmpty ? `<p class="card-note">${esc(card.passEmpty)}</p>` : ''}
    ${card.extra && card.extra.length ? rows(card.extra) : ''}
    ${card.note ? `<p class="card-note">${esc(card.note)}</p>` : ''}`;
  if (html !== cardBodyHtml) {
    cardBodyHtml = html;
    $('card-body').innerHTML = html;
  }
}

function satCardFor(sel, now) {
  const sat = state.sats[sel.index];
  if (!sat) return null;
  const group = TLE_GROUPS.find((g) => g.id === sat.group);
  const upcoming = (sel.passes || []).filter((p) => p.set.t > now);
  const visible = upcoming.filter((p) => p.visible && p.vis && p.vis.to.t > now);
  const list = visible.length ? visible : upcoming;
  const card = satCard(sat, sel.pos, state.fmt, now, {
    passes: list.slice(1, 6),
    next: list[0] || null,
    ageDays: tleAgeDays(sat, now),
    groupTitle: group ? group.title : '',
  });
  const rest = card.passes || [];
  card.passTitle = rest.length ? (visible.length ? 'Потом видимые пролёты' : 'Пролёты (глазом не видны: в тени Земли или светло)') : null;
  card.passEmpty = !upcoming.length ? 'Пролётов выше 10° в ближайшие 5 дней нет.' : null;
  return card;
}

function cardRect() {
  const card = $('card');
  return card.hidden ? null : card.getBoundingClientRect();
}

function hideCard() {
  $('card').hidden = true;
  $('card-body').innerHTML = '';
  cardBodyHtml = '';
}

// Навести ручную карту на объект. Если открыта карточка — ставим объект над ней, а не в центр.
function centerOn(sel) {
  if (!sel || !sel.vec || sensorsLive()) return;
  const { az, alt } = altAz(sel.vec);
  const r = cardRect();
  let shift = 0;
  if (r && r.left < view.width / 2 && r.right > view.width / 2) {
    const targetY = Math.max(110, (90 + r.top) / 2);
    shift = (view.height / 2 - targetY) * (view.effectiveFov / Math.min(view.width, view.height));
  }
  animateTo(az, Math.max(-90, Math.min(90, alt - shift)));
}

let anim = null;
function animateTo(az, alt) {
  const from = { ...settings.manual };
  const dAz = ((az - from.az + 540) % 360) - 180;
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
let modeSeq = 0;

async function setMode(mode, { fromGesture = false } = {}) {
  const token = ++modeSeq; // более позднее переключение отменяет незаконченное
  hideBanner('sensors');
  if (mode === 'sensors' || mode === 'ar') {
    if (!orientationSupported()) {
      toast('На этом устройстве нет датчиков ориентации — остаёмся в ручном режиме.');
      mode = 'manual';
    } else if (needsPermission() && fromGesture) {
      const res = await requestOrientationPermission();
      if (token !== modeSeq) return;
      if (res !== 'granted') {
        toast(MOTION_DENIED);
        mode = 'manual';
      }
    }
  }
  if (state.calibrating) endCalibration();
  if (mode === 'manual') {
    tracker.stop();
    state.relativeOffset = 0;
  } else tracker.start();
  if (mode === 'ar') {
    try {
      await startCamera(video);
      if (token !== modeSeq) return;
      document.body.classList.add('ar');
    } catch (err) {
      if (token !== modeSeq || err.name === 'AbortError') return;
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
  if (state.selection) {
    $('card-center').hidden = mode !== 'manual';
    renderCard(true);
  }
  state.dirty = true;
  if (mode !== 'manual') watchSensors();
}

const MOTION_DENIED = 'Доступ к датчикам не дан — пока крутите небо пальцем. Чтобы включить: полностью закройте Safari (или приложение с экрана «Домой»), откройте снова и нажмите «Разрешить».';

// Если через пару секунд данных от датчиков нет — подсказать.
let sensorWatch = 0;
function watchSensors() {
  clearTimeout(sensorWatch);
  sensorWatch = setTimeout(() => {
    if (settings.mode === 'manual' || tracker.hasData) return;
    if (needsPermission()) showBanner('sensors', 'Нажмите, чтобы включить датчики движения', () => setMode(settings.mode, { fromGesture: true }));
    else showBanner('sensors', 'Датчики не отвечают. Нажмите, чтобы перейти в ручной режим', () => setMode('manual'));
  }, 1800);
}

// Поправка к компасу: над настоящим компасом — сохранённая, без компаса — только на этот сеанс.
function compassCorrection() {
  return tracker.hasCompass ? settings.compassOffset : state.relativeOffset;
}

function applyView() {
  if (!sensorsLive()) {
    view.projection = 'stereo';
    view.focalOverride = null;
    view.fov = settings.manual.fov;
    view.lookAt(settings.manual.az, settings.manual.alt);
    return;
  }
  const axes = tracker.axes(state.declination, compassCorrection());
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

// Без компаса небо может быть повёрнуто — честно говорим об этом прямо на карте.
function renderCompassChip() {
  const chip = $('compass-chip');
  const show = sensorsLive() && !state.calibrating && !tracker.hasCompass;
  chip.hidden = !show;
  if (!show) return;
  let text;
  if (!tracker.waitingForCompass) text = 'Компаса нет — небо может быть повёрнуто. Выровнять';
  else if (screenAngle() % 180 !== 0) text = 'Ловлю компас: поверните телефон вертикально и на секунду наведите на горизонт';
  else text = 'Ловлю компас: держите телефон вертикально и на секунду наведите на горизонт';
  if (chip.textContent !== text) chip.textContent = text;
}

// Автотема следует за настоящим Солнцем, а не за временем на шкале.
function realSunAlt() {
  if (state.timeOffset === 0) return sky.sunAlt;
  const now = Date.now();
  if (state.realSunAlt === null || now - state.realSunAt > MIN) {
    state.realSunAlt = sky.sunAltAt(now);
    state.realSunAt = now;
  }
  return state.realSunAlt;
}

// ---------- кадр ----------

function frame(now) {
  requestAnimationFrame(frame);
  if (anim) {
    anim(now);
    state.dirty = true;
  }
  const interval = sensorsLive() ? 0 : state.sats.length ? 100 : 1000;
  if (!state.dirty && now - state.lastDraw < interval) return;
  if (!state.location) return;
  state.dirty = false;
  state.lastDraw = now;
  // Ошибка в одном кадре не должна останавливать карту навсегда.
  try {
    drawFrame();
  } catch (err) {
    console.error(err);
  }
}

function drawFrame() {
  const ms = skyTime();
  sky.update(ms);
  if (state.cat) sky.transformStars(state.cat);
  updateSatPositions(ms);
  updateTails(ms);
  applyView();
  updateSelection(ms);
  updateNight(realSunAlt());
  document.body.classList.toggle('live', sensorsLive());
  if (tracker.hasData) hideBanner('sensors'); // датчики заговорили — подсказка больше не нужна
  if (tracker.resets !== state.seenResets) {
    // после паузы в событиях углы без компаса отсчитываются заново — старая подстройка неверна
    state.seenResets = tracker.resets;
    state.relativeOffset = 0;
  }
  const r = cardRect();
  // Карточка во всю ширину снизу закрывает низ экрана; сбоку (альбом, планшет) — только себя.
  const fullWidth = r && r.left < view.width / 2 && r.right > view.width / 2;
  const cardTop = fullWidth ? r.top : view.height - 90;
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
    mode: sensorsLive() ? settings.mode : 'manual',
    selection: state.selection,
    insets: { top: 90, bottom: Math.max(90, view.height - cardTop) },
    occluder: r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom } : null,
  });
  renderTime(ms);
  renderCenterHint();
  renderCompassChip();
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
    const d = Math.floor(a / DAY);
    const h = Math.floor((a % DAY) / HOUR);
    const m = Math.round((a % HOUR) / MIN);
    const parts = [];
    if (d) parts.push(unit(d, 'сут'));
    if (h) parts.push(unit(h, 'ч'));
    if (m || !parts.length) parts.push(unit(m, 'мин'));
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
  if (!sensorsLive()) {
    el.hidden = true;
    return;
  }
  const now = performance.now();
  if (now - centerHintAt < 250) return;
  centerHintAt = now;
  const h = renderer.hitTest(view.width / 2, view.height / 2, 26);
  el.hidden = false;
  if (!h) {
    const c = view.center;
    el.textContent = `${Math.round(c.az) % 360}° ${direction8(c.az).short} · высота ${Math.round(c.alt)}°`;
    return;
  }
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
    if (settings.mode === 'ar' && sensorsLive()) return;
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
  if (!sensorsLive()) {
    anim = null;
    settings.manual.az = (settings.manual.az - dx * degPerPx + 360) % 360;
    settings.manual.alt = Math.max(-90, Math.min(90, settings.manual.alt + dy * degPerPx));
    state.dirty = true;
  } else if (state.calibrating) {
    const next = ((compassCorrection() - dx * degPerPx + 540) % 360) - 180;
    if (tracker.hasCompass) settings.compassOffset = next;
    else state.relativeOffset = next;
    $('calib-value').textContent = `${next > 0 ? '+' : ''}${decimal(next, 1)}°`;
    state.dirty = true;
  }
}

function onPointerUp(e) {
  pointers.delete(e.pointerId);
  if (gesture && gesture.type === 'tap' && pointers.size === 0) {
    const hit = renderer.hitTest(e.clientX, e.clientY);
    select(hit, { fromTap: true });
  }
  if (pointers.size === 0) {
    if (gesture && gesture.type !== 'tap') saveSettings();
    gesture = null;
  }
}

function onWheel(e) {
  if (settings.mode === 'ar' && sensorsLive()) return;
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
  $('place-locate').addEventListener('click', () => locate(true).then((ok) => ok && finishWelcome()));
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

let locating = false;

async function locate(fromSheet) {
  if (locating) return false;
  locating = true;
  const btn = fromSheet ? $('place-locate') : null;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Определяю…';
  }
  const seq = state.locSeq;
  try {
    const pos = await requestPosition({ highAccuracy: false });
    // пока ждали GPS, человек мог выбрать город — его выбор важнее
    if (state.locSeq !== seq) return true;
    setLocation(pos);
    if (fromSheet) closeSheets();
    return true;
  } catch (err) {
    $('place-error').hidden = false;
    $('place-error').textContent = err.message;
    if (!fromSheet) openSheet('place-sheet');
    return false;
  } finally {
    locating = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Определить моё место';
    }
  }
}

function bindModeSheet() {
  $('mode-btn').addEventListener('click', () => {
    document.querySelectorAll('[data-mode]').forEach((b) => {
      const cur = b.dataset.mode === settings.mode;
      b.classList.toggle('current', cur);
      b.setAttribute('aria-pressed', String(cur));
    });
    openSheet('mode-sheet');
  });
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
  let comp;
  if (tracker.mode === 'ios' && tracker.hasCompass) {
    comp = `Компас iPhone${tracker.accuracy !== null && tracker.accuracy >= 0 ? `, точность ±${Math.round(tracker.accuracy)}°` : ''}`;
  } else if (tracker.waitingForCompass) comp = 'Компас iPhone ещё не пойман — держите телефон вертикально (не боком) и на секунду наведите на горизонт';
  else if (tracker.mode === 'absolute') comp = 'Компас устройства';
  else if (tracker.mode === 'relative') comp = 'Компаса нет — выровняйте небо вручную';
  else comp = 'Датчики выключены (ручной режим)';
  const corr = compassCorrection();
  $('compass-status').textContent = `${comp}. Магнитное склонение здесь ${d >= 0 ? '+' : '−'}${decimal(Math.abs(d), 1)}° — учтено. Ручная поправка ${corr > 0 ? '+' : ''}${decimal(corr, 1)}°.`;
  renderSatStatus();
}

const GROUP_INLINE = { stations: 'станции и корабли', visual: 'яркие спутники', hubble: 'Хаббл', starlink: 'Starlink' };

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
  let newest = null;
  let loaded = null;
  const failedEmpty = [];
  let failedCached = 0;
  for (const g of TLE_GROUPS) {
    const s = src[g.id];
    if (!s) continue;
    if (s.newestEpochMs && (!newest || s.newestEpochMs > newest)) newest = s.newestEpochMs;
    if (s.fetchedAt && (!loaded || s.fetchedAt > loaded)) loaded = s.fetchedAt;
    if (s.error && !s.count) failedEmpty.push(GROUP_INLINE[g.id] || g.title);
    else if (s.error) failedCached++;
    if (s.count) parts.push(`${GROUP_INLINE[g.id] || g.title} — ${s.count}`);
  }
  const now = Date.now();
  let text = parts.length ? `Загружено: ${parts.join(', ')}.` : 'Спутники не загружены.';
  if (newest) {
    const days = (now - newest) / DAY;
    text += ` Самые свежие данные орбит — от ${whenText(state.fmt, newest, now)}.`;
    if (days > 3) text += ' Это давно: положения могут быть неточными, нужен интернет.';
  }
  if (loaded) text += ` Скачано ${whenText(state.fmt, loaded, now)}.`;
  if (failedEmpty.length) {
    text += ` Не загрузились: ${failedEmpty.join(', ')}${navigator.onLine === false ? ' — нет интернета' : ''}.`;
  }
  if (failedCached) text += ' Часть групп не обновилась — показаны сохранённые орбиты.';
  if (Object.values(src).some((s) => s.mirrorOutdated)) text += ' Запасная копия орбит на сайте устарела.';
  el.textContent = text;
}

function startCalibration() {
  closeSheets();
  if (!sensorsLive()) {
    toast('Подстройка компаса работает в режимах «Датчики» и AR.');
    return;
  }
  state.calibrating = true;
  document.body.classList.add('calibrating');
  $('calib').hidden = false;
  const corr = compassCorrection();
  $('calib-value').textContent = `${corr > 0 ? '+' : ''}${decimal(corr, 1)}°`;
}

function endCalibration() {
  state.calibrating = false;
  document.body.classList.remove('calibrating');
  $('calib').hidden = true;
  saveSettings();
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
      if (state.location) updateNight(realSunAlt());
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
  $('calib-start').addEventListener('click', startCalibration);
  $('calib-reset').addEventListener('click', () => {
    settings.compassOffset = 0;
    state.relativeOffset = 0;
    saveSettings();
    renderSettings();
    state.dirty = true;
  });
  $('calib-done').addEventListener('click', endCalibration);
  $('sat-refresh').addEventListener('click', () => refreshSatellites(true));
  $('compass-chip').addEventListener('click', () => {
    if (!tracker.waitingForCompass) startCalibration();
  });
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
      <b>${esc(o.name)}</b><span>${esc(o.alt > -0.5 ? `${Math.round(o.alt)}° · ${direction8(o.az).nom}` : 'под горизонтом')}${o.sunlit === false && o.alt > 0 ? ' · в тени Земли' : ''}</span></button></li>`;
  const satsHtml = items.some((o) => o.type === 'sat')
    ? `<h3>Спутники</h3><ul class="pick">${items.filter((o) => o.type === 'sat').map(row).join('')}</ul>`
    : `<h3>Спутники</h3><p class="muted">${state.satLoading ? 'Загружаю орбиты…' : 'Орбиты спутников не загружены — нужен интернет.'}</p>`;
  $('find-list').innerHTML = `
    <h3>Солнечная система</h3><ul class="pick">${items.filter((o) => o.type === 'body').map(row).join('')}</ul>
    ${satsHtml}
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
  toastTimer = setTimeout(() => (el.hidden = true), 6000);
}

// Баннеры с приоритетом: подсказка про датчики важнее напоминания обновить место;
// когда первая уходит, вторая возвращается.
const BANNER_ORDER = ['sensors', 'location'];
const banners = new Map();
let bannerAction = null;

function showBanner(kind, text, action) {
  banners.set(kind, { text, action });
  renderBanner();
}

function hideBanner(kind) {
  if (!banners.has(kind)) return;
  banners.delete(kind);
  renderBanner();
}

function renderBanner() {
  const el = $('banner');
  const kind = BANNER_ORDER.find((k) => banners.has(k));
  if (!kind) {
    el.hidden = true;
    bannerAction = null;
    return;
  }
  const b = banners.get(kind);
  el.textContent = b.text;
  el.hidden = false;
  bannerAction = b.action;
}

// ---------- первый запуск ----------

function finishWelcome() {
  $('welcome').hidden = true;
  storage.set('welcome-done-v1', true);
}

let starting = false;

function bindWelcome() {
  const startBtn = $('start-btn');
  const manualBtn = $('manual-start');
  const busy = (on, text) => {
    startBtn.disabled = on;
    manualBtn.disabled = on;
    startBtn.textContent = on ? text : 'Начать';
  };
  startBtn.addEventListener('click', () => {
    if (starting) return;
    starting = true;
    // На iOS разрешение на датчики — строго внутри нажатия, до любых await.
    const perm = requestOrientationPermission();
    busy(true, 'Определяю место…');
    // Датчики включаем, как только ответили про разрешение, не дожидаясь геолокации.
    perm.then((res) => {
      if (res === 'denied') toast(MOTION_DENIED);
      return setMode(res === 'granted' && orientationSupported() ? 'sensors' : 'manual');
    });
    locate(false)
      .then((ok) => ok && finishWelcome())
      .finally(() => {
        starting = false;
        busy(false);
      });
  });
  manualBtn.addEventListener('click', async () => {
    if (starting) return;
    starting = true;
    busy(true, 'Определяю место…');
    await setMode('manual');
    const ok = await locate(false);
    if (ok) finishWelcome();
    starting = false;
    busy(false);
  });
}

// ---------- запуск ----------

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Офлайн-режим недоступен', err));
}

function retryCatalog() {
  if (state.cat) return;
  loadCatalog()
    .then((cat) => {
      state.cat = cat;
      state.dirty = true;
    })
    .catch((err) => toast(`Каталог звёзд не загрузился (${err.message}). Попробую ещё раз, когда появится связь.`));
}

function satellitesStale() {
  const src = state.satSources;
  if (!src || !state.sats.length) return true;
  // данные с зеркала сайта устаревают быстрее: после них снова пробуем CelesTrak
  return Object.values(src).some((s) => !s.fetchedAt || Date.now() - s.fetchedAt > (s.from === 'mirror' ? 2 : 12) * HOUR);
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
  $('card-close').addEventListener('click', () => select(null));
  $('card-center').addEventListener('click', () => centerOn(state.selection));
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
    if (document.hidden) return;
    retryCatalog();
    if (satellitesStale()) refreshSatellites();
  });
  window.addEventListener('online', () => {
    retryCatalog();
    refreshSatellites();
  });
  // Пока спутников нет — тихо пробуем раз в 10 минут.
  setInterval(() => {
    if (!document.hidden && !state.sats.length) refreshSatellites();
  }, 10 * MIN);

  retryCatalog();
  refreshSatellites();

  const saved = getSavedLocation();
  if (saved) setLocation(saved, false);
  if (saved && storage.get('welcome-done-v1')) {
    $('welcome').hidden = true;
    setMode(settings.mode);
    refreshGpsOnLaunch(saved);
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
