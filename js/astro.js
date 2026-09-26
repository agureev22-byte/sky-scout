// Астрономия: Солнце, Луна, планеты и ядро Млечного Пути.
// Все расчёты — в браузере, библиотекой astronomy-engine (MIT), без интернета.

import * as A from '../vendor/astronomy.js';
import { DAY, MIN, normalize } from './intervals.js';

// Ядро Млечного Пути (Стрелец A*), координаты J2000.
A.DefineStar(A.Body.Star1, 17.7611, -29.0078, 26000);
const GALACTIC_CENTER = A.Body.Star1;

export const PLANETS = [
  { id: 'venus', body: A.Body.Venus, name: 'Венера', minAlt: 5 },
  { id: 'jupiter', body: A.Body.Jupiter, name: 'Юпитер', minAlt: 8 },
  { id: 'mars', body: A.Body.Mars, name: 'Марс', minAlt: 8 },
  { id: 'saturn', body: A.Body.Saturn, name: 'Сатурн', minAlt: 8 },
  { id: 'mercury', body: A.Body.Mercury, name: 'Меркурий', minAlt: 5 },
];

export function makeObserver(lat, lon, elevation = 0) {
  return new A.Observer(lat, lon, Number.isFinite(elevation) ? elevation : 0);
}

// Горизонтальные координаты тела. refraction=false — геометрическая высота
// (так определяются сумерки: Солнце на −6°, −12°, −18°).
export function horizontal(body, observer, ms, refraction = true) {
  const date = new Date(ms);
  const eq = A.Equator(body, date, observer, true, true);
  const hor = A.Horizon(date, observer, eq.ra, eq.dec, refraction ? 'normal' : undefined);
  return { alt: hor.altitude, az: hor.azimuth };
}

export function sunAltitude(observer, ms) {
  return horizontal(A.Body.Sun, observer, ms, false).alt;
}

// Общий построитель интервалов «тело выше/ниже порога» по событиям пересечения.
// findNext(direction, fromMs, limitDays) → момент пересечения (мс) или null;
// direction +1 — тело поднимается через порог, −1 — опускается.
function intervalsAbove(findNext, isAboveAt, start, end) {
  const limit = (end - start) / DAY + 0.01;
  const up = findNext(+1, start, limit);
  const down = findNext(-1, start, limit);
  let above;
  if (up === null && down === null) above = isAboveAt(start + (end - start) / 2);
  else if (up === null) above = true;
  else if (down === null) above = false;
  else above = down < up;

  const out = [];
  let t = start;
  for (let guard = 0; guard < 400 && t < end; guard++) {
    const next = findNext(above ? -1 : +1, t, (end - t) / DAY + 0.01);
    const segEnd = next === null || next > end ? end : next;
    if (above && segEnd > t) out.push({ start: t, end: segEnd });
    if (next === null || next >= end) break;
    t = next + 1000;
    above = !above;
  }
  return normalize(out);
}

// Интервалы, когда Солнце ниже заданной геометрической высоты.
export function sunBelow(observer, altitude, start, end) {
  const findNext = (dir, from, limit) => {
    // Солнце «ниже порога» — это «выше» для инвертированной логики, поэтому меняем направление.
    const r = A.SearchAltitude(A.Body.Sun, observer, -dir, new Date(from), limit, altitude);
    return r ? r.date.getTime() : null;
  };
  return intervalsAbove(findNext, (ms) => sunAltitude(observer, ms) < altitude, start, end);
}

// Интервалы, когда Луна над горизонтом (восход/заход верхнего края с рефракцией).
export function moonUp(observer, start, end) {
  const findNext = (dir, from, limit) => {
    const r = A.SearchRiseSet(A.Body.Moon, observer, dir, new Date(from), limit);
    return r ? r.date.getTime() : null;
  };
  const isUp = (ms) => horizontal(A.Body.Moon, observer, ms, true).alt > -0.8;
  return intervalsAbove(findNext, isUp, start, end);
}

// Восход/заход тела в пределах [start, end].
export function riseSet(body, observer, start, end) {
  const limit = (end - start) / DAY;
  const r = A.SearchRiseSet(body, observer, +1, new Date(start), limit);
  const s = A.SearchRiseSet(body, observer, -1, new Date(start), limit);
  const rise = r && r.date.getTime() <= end ? r.date.getTime() : null;
  const set = s && s.date.getTime() <= end ? s.date.getTime() : null;
  return { rise, set };
}

export function sunRiseSet(observer, start, end) {
  return riseSet(A.Body.Sun, observer, start, end);
}

// Минимальная и максимальная высота Солнца за интервал (шаг 15 минут + уточнение).
export function sunExtremes(observer, start, end) {
  let min = Infinity;
  let max = -Infinity;
  let minT = start;
  for (let t = start; t <= end; t += 15 * MIN) {
    const alt = sunAltitude(observer, t);
    if (alt < min) {
      min = alt;
      minT = t;
    }
    if (alt > max) max = alt;
  }
  // уточняем минимум рядом с найденной точкой
  for (let t = minT - 15 * MIN; t <= minT + 15 * MIN; t += 2 * MIN) {
    if (t < start || t > end) continue;
    const alt = sunAltitude(observer, t);
    if (alt < min) min = alt;
  }
  return { min, max };
}

const PHASES = [
  [10, 'новолуние'],
  [80, 'растущий серп'],
  [100, 'первая четверть'],
  [170, 'растущая Луна'],
  [190, 'полнолуние'],
  [260, 'убывающая Луна'],
  [280, 'последняя четверть'],
  [350, 'убывающий серп'],
  [361, 'новолуние'],
];

export function moonInfo(ms) {
  const date = new Date(ms);
  const angle = A.MoonPhase(date); // 0 — новолуние, 90 — первая четверть, 180 — полнолуние
  const illum = A.Illumination(A.Body.Moon, date).phase_fraction;
  const name = PHASES.find(([limit]) => angle < limit)[1];
  return { angle, illum, name, waxing: angle < 180 };
}

// Ближайшие новолуние и полнолуние после момента ms.
export function nextMoonPhases(ms) {
  const out = {};
  let q = A.SearchMoonQuarter(new Date(ms));
  for (let i = 0; i < 5 && (!out.new || !out.full); i++) {
    if (q.quarter === 0 && !out.new) out.new = q.time.date.getTime();
    if (q.quarter === 2 && !out.full) out.full = q.time.date.getTime();
    q = A.NextMoonQuarter(q);
  }
  return out;
}

export function planetMagnitude(body, ms) {
  return A.Illumination(body, new Date(ms)).mag;
}

// След объекта по небу на интервале: высота и азимут с шагом stepMin.
function track(body, observer, interval, stepMin = 10) {
  const out = [];
  const step = stepMin * MIN;
  for (let t = interval.start; t <= interval.end; t += step) out.push({ t, ...horizontal(body, observer, t, true) });
  if (out.length && out[out.length - 1].t < interval.end) {
    out.push({ t: interval.end, ...horizontal(body, observer, interval.end, true) });
  }
  return out;
}

function summarizeTrack(points, minAlt) {
  let best = null;
  let visibleFrom = null;
  let visibleTo = null;
  for (const p of points) {
    if (!best || p.alt > best.alt) best = p;
    if (p.alt >= minAlt) {
      if (visibleFrom === null) visibleFrom = p.t;
      visibleTo = p.t;
    }
  }
  if (!best || best.alt < minAlt) return null;
  return {
    best,
    visibleFrom,
    visibleTo,
    minAlt,
    points,
    first: points[0],
    last: points[points.length - 1],
  };
}

// Что видно на интервале: планеты (ярче +2,5 звёздной величины) и ядро Млечного Пути.
export function planetsInWindow(observer, interval) {
  const out = [];
  for (const p of PLANETS) {
    const s = summarizeTrack(track(p.body, observer, interval), p.minAlt);
    if (!s) continue;
    const mag = planetMagnitude(p.body, s.best.t);
    if (mag > 2.5) continue;
    const rs = riseSet(p.body, observer, interval.start, interval.end);
    out.push({ id: p.id, name: p.name, kind: 'planet', mag, ...s, rise: rs.rise, set: rs.set });
  }
  out.sort((a, b) => a.mag - b.mag);
  return out;
}

export function milkyWayCore(observer, interval, minAlt = 10) {
  const s = summarizeTrack(track(GALACTIC_CENTER, observer, interval), minAlt);
  if (!s) return null;
  const rs = riseSet(GALACTIC_CENTER, observer, interval.start, interval.end);
  return { id: 'milkyway', name: 'Ядро Млечного Пути', kind: 'milkyway', ...s, rise: rs.rise, set: rs.set };
}

export function moonInWindow(observer, interval) {
  const s = summarizeTrack(track(A.Body.Moon, observer, interval), 3);
  if (!s) return null;
  const rs = riseSet(A.Body.Moon, observer, interval.start, interval.end);
  return { id: 'moon', name: 'Луна', kind: 'moon', ...s, rise: rs.rise, set: rs.set, info: moonInfo(s.best.t) };
}

// Все «календарные» события неба для ночи — используются для подписей.
export function nightEvents(observer, start, end) {
  const sun = sunRiseSet(observer, start, end);
  const moon = riseSet(A.Body.Moon, observer, start, end);
  return { sunset: sun.set, sunrise: sun.rise, moonrise: moon.rise, moonset: moon.set };
}


// Когда Солнце в следующий раз опустится ниже порога (для белых ночей и полярного дня).
export function nextSunBelow(observer, fromMs, altitude) {
  const r = A.SearchAltitude(A.Body.Sun, observer, -1, new Date(fromMs), 366, altitude);
  return r ? r.date.getTime() : null;
}

export function nextSunset(observer, fromMs) {
  const r = A.SearchRiseSet(A.Body.Sun, observer, -1, new Date(fromMs), 366);
  return r ? r.date.getTime() : null;
}
