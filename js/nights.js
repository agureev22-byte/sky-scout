// Оценка ночей: когда темно, когда ясно, когда мешает Луна.
// Каждая «ночь» — сутки от местного солнечного полудня до следующего,
// так одинаково работают и обычные широты, и белые ночи, и полярные день и ночь.

import * as I from './intervals.js';
import { DAY, HOUR, MIN } from './intervals.js';
import {
  makeObserver, sunBelow, moonUp, moonInfo, sunExtremes, nightEvents, sunAltitude,
  planetsInWindow, milkyWayCore, moonInWindow,
} from './astro.js';
import { coverage, cloudBelow, weatherStats } from './weather.js';

export const CLEAR = 30; // % облачности, до которого небо считаем ясным
export const PARTLY = 65; // до этого — переменная облачность, звёзды в просветах
export const MOON_BRIGHT = 0.2; // Луна освещена больше чем на 20% — мешает Млечному Пути
const GAP = 20 * MIN; // короткие «провалы» в прогнозе не рвут окно
const NEAR = 2 * MIN;

// Границы суток-ночей: от местного среднего солнечного полудня.
export function nightSlices(lon, now, count) {
  const off = (lon / 15) * HOUR;
  const first = Math.floor((now + off - 12 * HOUR) / DAY) * DAY + 12 * HOUR - off;
  return Array.from({ length: count }, (_, k) => ({ start: first + k * DAY, end: first + (k + 1) * DAY }));
}

function clean(list) {
  return I.mergeGaps(list, GAP);
}

// Что определяет начало/конец окна: сумерки, Луна, облака или просто «сейчас».
function startCause(t, n) {
  if (n.index === 0 && t <= n.from + NEAR && n.from > n.start) return 'now';
  if ([...n.obsFull, ...n.deepFull].some((i) => Math.abs(i.start - t) <= NEAR)) return 'dusk';
  if (n.moon.upFull.some((i) => Math.abs(i.end - t) <= NEAR)) return 'moonset';
  return 'clouds';
}

function endCause(t, n) {
  if ([...n.obsFull, ...n.deepFull].some((i) => Math.abs(i.end - t) <= NEAR)) return 'dawn';
  if (n.moon.upFull.some((i) => Math.abs(i.start - t) <= NEAR)) return 'moonrise';
  if (n.coverageList.length && Math.abs(n.coverageList[n.coverageList.length - 1].end - t) <= NEAR) return 'forecast-end';
  return 'clouds';
}

function describeWindow(w, n) {
  if (!w) return null;
  return { start: w.start, end: w.end, startCause: startCause(w.start, n), endCause: endCause(w.end, n) };
}

export function evaluateNight(ctx, slice, index) {
  const { observer, hours, now } = ctx;
  const { start, end } = slice;
  const from = index === 0 ? Math.max(start, now) : start;
  const ext = sunExtremes(observer, start, end);
  // Порог «уже темно»: −12° (видны звёзды), в светлые ночи — хотя бы −6°.
  const obsLimit = ext.min <= -12 ? -12 : ext.min <= -6 ? -6 : null;
  // Порог «полная темнота» для Млечного Пути: −18°, летом на севере — хотя бы −15°.
  const deepLimit = ext.min <= -18 ? -18 : ext.min <= -15 ? -15 : null;

  const obsFull = obsLimit ? sunBelow(observer, obsLimit, start, end) : [];
  const deepFull = deepLimit ? sunBelow(observer, deepLimit, start, end) : [];
  const civilFull = sunBelow(observer, -6, start, end);
  const events = nightEvents(observer, start, end);

  const upFull = moonUp(observer, start, end);
  const darkMid = obsFull.length ? (obsFull[0].start + obsFull[obsFull.length - 1].end) / 2 : start + DAY / 2;
  const mi = moonInfo(darkMid);
  const moonBright = mi.illum >= MOON_BRIGHT;
  const moonBrightUp = moonBright ? upFull : [];

  const obs = I.clip(obsFull, from, end);
  const deep = I.clip(deepFull, from, end);
  const obsMs = I.totalLength(obs);

  const coverageList = hours ? I.clip(coverage(hours), start, end) : [];
  const clear = hours ? cloudBelow(hours, CLEAR) : [];
  const partly = hours ? cloudBelow(hours, PARTLY) : [];
  const coveredObsMs = I.totalLength(I.intersect(obs, coverageList));
  const coverageRatio = obsMs ? coveredObsMs / obsMs : 0;

  const n = {
    index,
    start,
    end,
    from,
    evening: start + 6 * HOUR,
    sun: { min: ext.min, max: ext.max, obsLimit, deepLimit },
    events,
    obsFull,
    deepFull,
    civilFull,
    obs,
    deep,
    obsMs,
    moon: { ...mi, bright: moonBright, upFull, up: I.clip(upFull, from, end) },
    coverageList,
    coverageRatio,
    coverage: coverageRatio >= 0.9 ? 'full' : coverageRatio >= 0.2 ? 'partial' : 'none',
  };

  const minWindow = Math.max(15 * MIN, Math.min(60 * MIN, 0.5 * obsMs));
  const great = deepLimit ? I.longest(clean(I.subtract(I.intersect(deep, clear), moonBrightUp))) : null;
  const clearDeep = deepLimit ? I.longest(clean(I.intersect(deep, clear))) : null;
  const clearW = I.longest(clean(I.intersect(obs, clear)));
  const partlyW = I.longest(clean(I.intersect(obs, partly)));
  // Без прогноза: лучшее астрономическое окно (темно и без яркой Луны).
  const darkNoMoon = deepLimit ? I.longest(clean(I.subtract(deep, moonBrightUp))) : null;

  let rating;
  let reason = null;
  let window = null;
  if (!obsMs) {
    rating = 'nodark';
  } else if (n.coverage === 'none') {
    rating = 'unknown';
    window = darkNoMoon && I.length(darkNoMoon) >= minWindow ? darkNoMoon : I.longest(obs);
  } else if (great && I.length(great) >= minWindow) {
    rating = 'great';
    window = great;
  } else if (clearW && I.length(clearW) >= minWindow) {
    rating = 'good';
    window = clearW;
    if (!deepLimit) reason = 'twilight';
    else if (clearDeep && I.length(clearDeep) >= minWindow) reason = 'moon';
    else reason = 'short';
  } else if (partlyW && I.length(partlyW) >= minWindow) {
    rating = 'maybe';
    window = partlyW;
  } else {
    rating = 'bad';
  }

  n.rating = rating;
  n.reason = reason;
  n.minWindow = minWindow;
  n.window = describeWindow(window, n);
  n.windows = {
    great: describeWindow(great, n),
    clear: describeWindow(clearW, n),
    partly: describeWindow(partlyW, n),
    clearDeep: describeWindow(clearDeep, n),
  };
  // Ясный промежуток, внутри которого лежит «отличное» окно (до него может светить Луна).
  n.clearAround = window && clearW ? describeWindow(I.bestOverlap(clean(I.intersect(obs, clear)), window), n) : null;
  n.statsNight = hours ? weatherStats(hours, obs) : null;
  n.statsWindow = hours && window ? weatherStats(hours, [window]) : null;
  n.clearIntervals = hours ? clean(I.intersect(obs, clear)) : [];
  return n;
}

export function evaluateNights({ lat, lon, elevation = 0, now, weather = null, count = 8 }) {
  const observer = makeObserver(lat, lon, elevation);
  const hours = weather && weather.hours && weather.hours.t.length ? weather.hours : null;
  const ctx = { observer, hours, now };
  let slices = nightSlices(lon, now, count + 1);
  const first = evaluateNight(ctx, slices[0], 0);
  // Если нынешняя ночь уже закончилась (утро), «сегодня» — следующая.
  const lastDark = first.obsFull.length ? first.obsFull[first.obsFull.length - 1].end : null;
  const over = lastDark !== null ? lastDark - now < 20 * MIN : now > slices[0].start + 12 * HOUR;
  const nights = [];
  if (over) slices = slices.slice(1);
  else nights.push(first);
  for (let i = nights.length; i < count; i++) nights.push(evaluateNight(ctx, slices[i], i));
  return { observer, ctx, nights, sunAltNow: sunAltitude(observer, now) };
}

// Что будет видно в окне ночи: планеты, ядро Млечного Пути, Луна.
export function objectsForNight(ctx, n, light) {
  if (!n.window) return [];
  const { observer } = ctx;
  // Для планет годятся и сумерки (Солнце ниже −6°), если ясно.
  let span = I.bestOverlap(I.clip(n.civilFull, n.from, n.end), n.window) || n.window;
  if (ctx.hours && n.rating !== 'unknown') {
    const clearCivil = clean(I.intersect(I.clip(n.civilFull, n.from, n.end), cloudBelow(ctx.hours, n.rating === 'maybe' ? PARTLY : CLEAR)));
    span = I.bestOverlap(clearCivil, n.window) || n.window;
  }
  const out = [];
  const moon = moonInWindow(observer, span);
  const planets = planetsInWindow(observer, span);
  let mw = null;
  const darkWindow = n.rating === 'great' ? n.windows.great : n.rating === 'unknown' ? n.window : null;
  if (darkWindow && n.sun.deepLimit && (!light || light.milkyWay !== 'none')) {
    mw = milkyWayCore(observer, darkWindow);
    if (mw && light) mw.quality = light.milkyWay;
  }
  const moonMatters = moon && n.moon.bright;
  if (moonMatters) out.push(moon);
  out.push(...planets);
  if (mw) out.push(mw);
  if (moon && !moonMatters && moon.info.illum >= 0.05) out.push(moon);
  return out.map((o) => ({ ...o, span }));
}
