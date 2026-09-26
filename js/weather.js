// Прогноз облачности Open-Meteo (бесплатно, без ключа, весь мир) и его кэш на телефоне.

import { HOUR, MIN, normalize, intersect, totalLength } from './intervals.js';
import { storage } from './storage.js';

const API = 'https://api.open-meteo.com/v1/forecast';
const CACHE_KEY = 'forecast-v1';
export const FORECAST_DAYS = 8;
// Кэш считается свежим час; старше — перезапрашиваем, но при отсутствии связи показываем что есть.
export const FRESH_MS = HOUR;
// Кэш подходит для места, если оно не дальше этого расстояния.
const CACHE_RADIUS_KM = 15;

const HOURLY = [
  'cloud_cover',
  'cloud_cover_low',
  'cloud_cover_mid',
  'cloud_cover_high',
  'precipitation_probability',
  'temperature_2m',
  'relative_humidity_2m',
  'wind_speed_10m',
];

export function forecastUrl(lat, lon) {
  const params = new URLSearchParams({
    latitude: lat.toFixed(3),
    longitude: lon.toFixed(3),
    hourly: HOURLY.join(','),
    wind_speed_unit: 'ms',
    timezone: 'auto',
    timeformat: 'unixtime',
    forecast_days: String(FORECAST_DAYS),
  });
  return `${API}?${params}`;
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// «Эффективная» облачность для наблюдений: высокие перистые облака полупрозрачны,
// поэтому считаем их за половину. Слои складываем как независимые.
export function effectiveCloud(total, low, mid, high) {
  if (low === null || mid === null || high === null) return total;
  const layered = 100 * (1 - (1 - low / 100) * (1 - mid / 100) * (1 - (0.5 * high) / 100));
  return total === null ? layered : Math.min(total, layered);
}

export function parseForecast(json, fetchedAt = Date.now()) {
  if (!json || !json.hourly || !Array.isArray(json.hourly.time)) throw new Error('Неожиданный ответ сервера погоды');
  const h = json.hourly;
  const n = h.time.length;
  const col = (name) => (Array.isArray(h[name]) ? h[name].map(num) : new Array(n).fill(null));
  const total = col('cloud_cover');
  const low = col('cloud_cover_low');
  const mid = col('cloud_cover_mid');
  const high = col('cloud_cover_high');
  const hours = {
    t: h.time.map((s) => s * 1000),
    total,
    low,
    mid,
    high,
    cloud: total.map((v, i) => effectiveCloud(v, low[i], mid[i], high[i])),
    precip: col('precipitation_probability'),
    temp: col('temperature_2m'),
    humidity: col('relative_humidity_2m'),
    wind: col('wind_speed_10m'),
  };
  return {
    fetchedAt,
    lat: json.latitude,
    lon: json.longitude,
    elevation: num(json.elevation),
    timezone: typeof json.timezone === 'string' ? json.timezone : null,
    hours,
  };
}

export async function fetchForecast(lat, lon, { timeoutMs = 15000 } = {}) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetch(forecastUrl(lat, lon), { signal: ctrl ? ctrl.signal : undefined });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json || json.error) {
      throw new Error(json && json.reason ? `Open-Meteo: ${json.reason}` : `Open-Meteo: ошибка ${res.status}`);
    }
    return parseForecast(json);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function distanceKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r;
  const dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function loadCachedForecast(lat, lon) {
  const c = storage.get(CACHE_KEY);
  if (!c || !c.hours || !Array.isArray(c.hours.t)) return null;
  if (!Number.isFinite(c.queryLat) || distanceKm(lat, lon, c.queryLat, c.queryLon) > CACHE_RADIUS_KM) return null;
  return c;
}

export function saveForecast(data, lat, lon) {
  storage.set(CACHE_KEY, { ...data, queryLat: lat, queryLon: lon });
}

// Получить прогноз: свежий кэш → сеть → устаревший кэш.
// Возвращает {data, fromCache, error}.
export async function getForecast(lat, lon, { force = false, now = Date.now() } = {}) {
  const cached = loadCachedForecast(lat, lon);
  if (cached && !force && now - cached.fetchedAt < FRESH_MS) return { data: cached, fromCache: true, error: null };
  try {
    const data = await fetchForecast(lat, lon);
    saveForecast(data, lat, lon);
    return { data, fromCache: false, error: null };
  } catch (err) {
    return { data: cached, fromCache: !!cached, error: err };
  }
}

// ---- Анализ облачности ----

// Интервалы, на которые есть данные прогноза (подряд идущие часы без пропусков).
export function coverage(hours) {
  const out = [];
  const { t, cloud } = hours;
  for (let i = 0; i < t.length - 1; i++) {
    if (cloud[i] !== null && cloud[i + 1] !== null && t[i + 1] - t[i] <= 3 * HOUR) {
      out.push({ start: t[i], end: t[i + 1] });
    }
  }
  return normalize(out);
}

// Линейная интерполяция ряда на момент ms (null — если данных нет).
export function valueAt(hours, series, ms) {
  const { t } = hours;
  const v = hours[series];
  if (!t.length || ms < t[0] || ms > t[t.length - 1]) return null;
  let lo = 0;
  let hi = t.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (t[m] <= ms) lo = m;
    else hi = m;
  }
  if (t[lo] === ms || hi === lo) return v[lo];
  const a = v[lo];
  const b = v[hi];
  if (a === null || b === null) return a === null ? b : a;
  return a + ((b - a) * (ms - t[lo])) / (t[hi] - t[lo]);
}

// Интервалы, где облачность (интерполированная) не больше порога.
export function cloudBelow(hours, threshold) {
  const out = [];
  const { t, cloud } = hours;
  for (let i = 0; i < t.length - 1; i++) {
    const a = cloud[i];
    const b = cloud[i + 1];
    if (a === null || b === null || t[i + 1] - t[i] > 3 * HOUR) continue;
    const t0 = t[i];
    const t1 = t[i + 1];
    if (a <= threshold && b <= threshold) out.push({ start: t0, end: t1 });
    else if (a <= threshold) out.push({ start: t0, end: t0 + ((threshold - a) / (b - a)) * (t1 - t0) });
    else if (b <= threshold) out.push({ start: t0 + ((a - threshold) / (a - b)) * (t1 - t0), end: t1 });
  }
  return normalize(out);
}

// Сводка погоды за интервалы (например, за тёмное время ночи).
export function weatherStats(hours, intervals) {
  const covered = intersect(intervals, coverage(hours));
  const coveredMs = totalLength(covered);
  if (!coveredMs) return null;
  const acc = { cloud: [], total: [], low: [], mid: [], high: [], precip: [], temp: [], humidity: [], wind: [] };
  for (const iv of covered) {
    for (let ms = iv.start; ms <= iv.end; ms += 20 * MIN) {
      for (const k of Object.keys(acc)) {
        const v = valueAt(hours, k, ms);
        if (v !== null) acc[k].push(v);
      }
    }
  }
  const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  const max = (a) => (a.length ? Math.max(...a) : null);
  const min = (a) => (a.length ? Math.min(...a) : null);
  return {
    coveredMs,
    cloudAvg: avg(acc.cloud),
    cloudMax: max(acc.cloud),
    cloudMin: min(acc.cloud),
    totalAvg: avg(acc.total),
    lowAvg: avg(acc.low),
    midAvg: avg(acc.mid),
    highAvg: avg(acc.high),
    precipMax: max(acc.precip),
    tempMin: min(acc.temp),
    tempMax: max(acc.temp),
    humidityMax: max(acc.humidity),
    windMax: max(acc.wind),
  };
}

