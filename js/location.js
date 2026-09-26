// Где стоит наблюдатель: геолокация телефона, поиск города, ручные координаты.

import { storage } from './storage.js';

const KEY = 'location-v1';

export function getSavedLocation() {
  const loc = storage.get(KEY);
  if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lon)) return loc;
  return null;
}

export function saveLocation(loc) {
  storage.set(KEY, loc);
}

export function distanceKm(a, b) {
  const r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r;
  const dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function geolocationSupported() {
  return typeof navigator !== 'undefined' && 'geolocation' in navigator;
}

// 'granted' | 'denied' | 'prompt' | 'unknown'
export async function geolocationPermission() {
  try {
    if (!navigator.permissions || !navigator.permissions.query) return 'unknown';
    const s = await navigator.permissions.query({ name: 'geolocation' });
    return s.state;
  } catch {
    return 'unknown';
  }
}

const GEO_ERRORS = {
  1: 'Доступ к геопозиции запрещён. Разрешите его в настройках телефона (Конфиденциальность → Службы геолокации → Safari) или выберите город вручную.',
  2: 'Телефон не смог определить место. Выйдите на открытое место или выберите город вручную.',
  3: 'Геопозиция определяется слишком долго. Попробуйте ещё раз или выберите город вручную.',
};

export function requestPosition({ timeout = 20000, maximumAge = 10 * 60 * 1000, highAccuracy = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!geolocationSupported()) {
      reject(Object.assign(new Error('Этот браузер не умеет определять геопозицию. Выберите город вручную.'), { code: 0 }));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        resolve({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          elevation: Number.isFinite(pos.coords.altitude) ? pos.coords.altitude : null,
          accuracy: pos.coords.accuracy,
          source: 'gps',
          name: null,
          timezone: null,
          updatedAt: Date.now(),
        });
      },
      (err) => {
        reject(Object.assign(new Error(GEO_ERRORS[err.code] || 'Не удалось определить место.'), { code: err.code }));
      },
      { enableHighAccuracy: highAccuracy, timeout, maximumAge },
    );
  });
}

// Поиск населённого пункта через геокодер Open-Meteo (бесплатно, без ключа).
export async function searchPlaces(query, { signal } = {}) {
  const q = query.trim();
  if (q.length < 2) return [];
  const params = new URLSearchParams({ name: q, count: '8', language: 'ru', format: 'json' });
  const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${params}`, { signal });
  if (!res.ok) throw new Error(`Поиск не удался (${res.status})`);
  const json = await res.json();
  return (json.results || []).map((r) => ({
    lat: r.latitude,
    lon: r.longitude,
    elevation: Number.isFinite(r.elevation) ? r.elevation : null,
    name: r.name,
    region: [r.admin1, r.country].filter(Boolean).join(', '),
    timezone: r.timezone || null,
    source: 'search',
  }));
}

// «41.39, 2.17» или «41,39 2,17» → {lat, lon}
export function parseCoords(text) {
  const nums = String(text)
    .replace(/(\d),(\d)/g, '$1.$2')
    .match(/[-−+]?\d+(?:\.\d+)?/g);
  if (!nums || nums.length !== 2) return null;
  const [lat, lon] = nums.map((s) => Number(s.replace('−', '-')));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}
