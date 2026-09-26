// Приблизительная оценка засветки (яркости ночного неба, класс по шкале Бортля)
// по близости к городам. Работает офлайн, без ключей и без зависимостей —
// и в браузере, и в Node.
//
// Data: data/cities.json, built by tools/build-cities.mjs from GeoNames
// (CC BY 4.0) via the npm package all-the-cities. Cities with population >= 5000.
//
// Model — Walker's law with a finite city core:
//   R_i = K · P_i · (d_i² + r_i²)^(−1.25)
//   * Walker's law: sky glow from a city grows linearly with its population P
//     and falls off with distance as d^−2.5.
//   * K = 0.005 scales it to the natural sky brightness, so R is the ratio
//     "artificial / natural" sky brightness (dimensionless).
//   * r_i = 0.432 · P_i^0.2045 km is a "core radius" that grows with the size of
//     the city (≈4 km for 50k people, ≈9 km for 3M). Without it d^−2.5 blows up
//     at the city centre; with it the value saturates inside the city.
//   * R = Σ R_i over cities within 300 km (further away the glow is below the
//     precision of such an estimate and is mostly hidden below the horizon).
//   SQM = 22.0 − 2.5·log10(1 + R): 22.0 mag/arcsec² is a pristine natural sky,
//   the artificial part adds (1 + R) times more light.
//   Bortle class from SQM — standard table (Wikipedia, "Bortle scale").
//
// Это оценка, а не измерение: реальная засветка зависит от освещения конкретного
// города, рельефа, погоды и т. п. Поэтому в результате всегда approximate: true.

const EARTH_RADIUS_KM = 6371;
const K = 0.005;
const CORE_A = 0.432;
const CORE_B = 0.2045;
const MAX_DISTANCE_KM = 300;
const NATURAL_SQM = 22.0;
// A named city may be reported as the main source when the strongest
// contributor overall is an anonymous small town, but only if it has at least
// this share of the total artificial glow.
const MIN_NAMED_SHARE = 0.15;

const DEG = Math.PI / 180;
const MAX_ANGLE = MAX_DISTANCE_KM / EARTH_RADIUS_KM; // radians
const MAX_DLAT_DEG = MAX_ANGLE / DEG + 0.02; // + margin for the 0.01° rounding of the data
const SIN_HALF_MAX = Math.sin(MAX_ANGLE / 2);
const MAX_HAV = SIN_HALF_MAX * SIN_HALF_MAX; // haversine value at MAX_DISTANCE_KM

// Тексты по классам Бортля (индекс = класс 1..9).
const CLASSES = [
  null,
  { level: 'excellent', label: 'очень тёмное небо', milkyWay: 'good',
    description: 'Настоящая темнота: Млечный Путь яркий, с деталями, видно тысячи звёзд.' },
  { level: 'dark', label: 'тёмное небо', milkyWay: 'good',
    description: 'Тёмное небо: Млечный Путь хорошо виден глазом, с деталями.' },
  { level: 'rural', label: 'сельское небо', milkyWay: 'good',
    description: 'Сельское небо: Млечный Путь хорошо виден, у горизонта небо чуть светлее.' },
  { level: 'transition', label: 'небо у посёлка', milkyWay: 'visible',
    description: 'Небо у посёлка: Млечный Путь виден, но без мелких деталей, у горизонта засветка.' },
  { level: 'suburban', label: 'пригород', milkyWay: 'faint',
    description: 'Пригород: Млечный Путь еле заметен глазом, камера его вытянет.' },
  { level: 'bright-suburban', label: 'яркий пригород', milkyWay: 'camera',
    description: 'Яркий пригород: Млечный Путь глазом почти не виден, камера покажет его с трудом.' },
  { level: 'urban', label: 'город', milkyWay: 'none',
    description: 'Город: Млечного Пути не видно. Остаются Луна, планеты и яркие звёзды.' },
  { level: 'city', label: 'центр города', milkyWay: 'none',
    description: 'Центр города: видны только Луна, планеты и самые яркие звёзды.' },
  { level: 'city', label: 'центр города', milkyWay: 'none',
    description: 'Центр города: видны только Луна, планеты и самые яркие звёзды.' },
];

// Sky brightness (mag/arcsec²) from the artificial/natural brightness ratio.
export function sqmFromRatio(R) {
  return NATURAL_SQM - 2.5 * Math.log10(1 + Math.max(0, R));
}

// Bortle class 1..9 from SQM (mag/arcsec²).
export function bortleFromSqm(sqm) {
  if (sqm >= 21.76) return 1;
  if (sqm >= 21.6) return 2;
  if (sqm >= 21.25) return 3;
  if (sqm >= 20.3) return 4;
  if (sqm >= 19.25) return 5;
  if (sqm >= 18.5) return 6;
  if (sqm >= 18.0) return 7;
  if (sqm >= 17.5) return 8;
  return 9;
}

// Turns the raw JSON of data/cities.json into column arrays sorted by latitude,
// with everything the estimate needs precomputed per city.
export function prepareCities(json) {
  if (!json || !Array.isArray(json.d) || !Array.isArray(json.names)) {
    throw new Error('Некорректный файл городов: нет полей d/names');
  }
  const n = Math.floor(json.d.length / 3);
  if (n * 3 !== json.d.length || (json.count != null && json.count !== n)) {
    throw new Error('Некорректный файл городов: длина d не совпадает с count');
  }
  const d = json.d;
  const namedCount = Math.min(json.namedCount ?? json.names.length, json.names.length, n);

  // Sort the indices by latitude so a lookup only scans a latitude band.
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => d[a * 3] - d[b * 3]);

  const latDeg = new Float64Array(n);
  const lonDeg = new Float64Array(n);
  const latRad = new Float64Array(n);
  const lonRad = new Float64Array(n);
  const cosLat = new Float64Array(n);
  const kp = new Float64Array(n); // K · P
  const core2 = new Float64Array(n); // r² (km²)
  const population = new Int32Array(n);
  const nameIdx = new Int32Array(n); // index into names, or −1

  for (let j = 0; j < n; j++) {
    const i = order[j];
    const lat = d[i * 3] / 100;
    const lon = d[i * 3 + 1] / 100;
    const pop = Math.max(1, d[i * 3 + 2]) * 1000;
    const r = CORE_A * Math.pow(pop, CORE_B);
    latDeg[j] = lat;
    lonDeg[j] = lon;
    latRad[j] = lat * DEG;
    lonRad[j] = lon * DEG;
    cosLat[j] = Math.cos(lat * DEG);
    kp[j] = K * pop;
    core2[j] = r * r;
    population[j] = pop;
    nameIdx[j] = i < namedCount ? i : -1;
  }

  return {
    count: n,
    names: json.names.slice(0, namedCount),
    source: json.source || '',
    latDeg, lonDeg, latRad, lonRad, cosLat, kp, core2, population, nameIdx,
  };
}

function isPrepared(cities) {
  return cities && cities.latDeg instanceof Float64Array && typeof cities.count === 'number';
}

const preparedCache = new WeakMap();
function ensurePrepared(cities) {
  if (isPrepared(cities)) return cities;
  if (cities && typeof cities === 'object') {
    let p = preparedCache.get(cities);
    if (!p) {
      p = prepareCities(cities);
      preparedCache.set(cities, p);
    }
    return p;
  }
  throw new TypeError('estimateLightPollution: нужен набор городов из loadCities() или prepareCities()');
}

const loadCache = new Map();

// Loads and prepares data/cities.json once (per URL). The returned promise
// rejects with an Error on failure; a failed load is not cached, so a later
// call retries.
export function loadCities(url = new URL('../data/cities.json', import.meta.url)) {
  const key = String(url);
  let p = loadCache.get(key);
  if (!p) {
    p = fetchJson(url).then(prepareCities);
    loadCache.set(key, p);
    p.catch(() => loadCache.delete(key));
  }
  return p;
}

async function fetchJson(url) {
  let href;
  try {
    href = new URL(String(url), typeof location !== 'undefined' ? location.href : undefined);
  } catch {
    href = null;
  }
  // Node: fetch() cannot read file: URLs — read the file directly.
  if (href && href.protocol === 'file:') {
    try {
      const fs = await import('node:fs/promises');
      return JSON.parse(await fs.readFile(href, 'utf8'));
    } catch (err) {
      throw new Error(`Не удалось прочитать данные о городах: ${err.message}`);
    }
  }
  let res;
  try {
    res = await fetch(href || url);
  } catch (err) {
    throw new Error(`Не удалось загрузить данные о городах: ${err && err.message ? err.message : err}`);
  }
  if (!res.ok) throw new Error(`Не удалось загрузить данные о городах: HTTP ${res.status}`);
  try {
    return await res.json();
  } catch (err) {
    throw new Error(`Файл городов повреждён: ${err.message}`);
  }
}

// Lower bound: first index j with latDeg[j] >= value.
function lowerBound(arr, value) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function round(x, digits) {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

// Initial bearing from point 1 toward point 2, degrees 0..359 (0 = N, 90 = E).
function bearingDeg(lat1, lon1, lat2, lon2) {
  const dl = lon2 - lon1;
  const y = Math.sin(dl) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dl);
  const b = Math.round(((Math.atan2(y, x) / DEG) % 360 + 360) % 360);
  return b === 360 ? 0 : b;
}

// Приблизительная засветка в точке (lat, lon в градусах).
export function estimateLightPollution(lat, lon, cities) {
  lat = Number(lat);
  lon = Number(lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new TypeError('estimateLightPollution: координаты должны быть числами');
  }
  const c = ensurePrepared(cities);
  lat = Math.max(-90, Math.min(90, lat));
  if (lon < -180 || lon > 180) lon = ((((lon + 180) % 360) + 360) % 360) - 180;

  const phi = lat * DEG;
  const lambda = lon * DEG;
  const cosPhi = Math.cos(phi);

  // Longitude prefilter half-width. Near the poles (or if the box would span
  // the whole globe) it is skipped; otherwise dLon = dLat / cos(max |lat|
  // inside the band), which is a conservative bound for a 300 km circle.
  const maxAbsLat = Math.abs(lat) + MAX_DLAT_DEG;
  let dLonMax = Infinity;
  if (maxAbsLat < 89) {
    dLonMax = MAX_DLAT_DEG / Math.cos(maxAbsLat * DEG);
    if (dLonMax >= 180) dLonMax = Infinity;
  }

  const { latDeg, lonDeg, latRad, lonRad, cosLat, kp, core2 } = c;
  const start = lowerBound(latDeg, lat - MAX_DLAT_DEG);
  const latHi = lat + MAX_DLAT_DEG;

  let total = 0;
  let best = -1;
  let bestR = 0;
  let bestNamed = -1;
  let bestNamedR = 0;
  let bestNamedD = 0;
  let bestD = 0;

  for (let j = start; j < c.count; j++) {
    if (latDeg[j] > latHi) break;
    if (dLonMax !== Infinity) {
      let dl = lonDeg[j] - lon;
      if (dl > 180) dl -= 360;
      else if (dl < -180) dl += 360;
      if (dl > dLonMax || dl < -dLonMax) continue;
    }
    // Haversine; compare against the 300 km limit before taking asin.
    const sDlat = Math.sin((latRad[j] - phi) / 2);
    const sDlon = Math.sin((lonRad[j] - lambda) / 2);
    const h = sDlat * sDlat + cosPhi * cosLat[j] * sDlon * sDlon;
    if (h > MAX_HAV) continue;
    const dist = 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
    const s = dist * dist + core2[j];
    const ri = kp[j] / (s * Math.sqrt(Math.sqrt(s))); // K·P·s^−1.25
    total += ri;
    if (ri > bestR) {
      bestR = ri;
      best = j;
      bestD = dist;
    }
    if (c.nameIdx[j] >= 0 && ri > bestNamedR) {
      bestNamedR = ri;
      bestNamed = j;
      bestNamedD = dist;
    }
  }

  const sqm = sqmFromRatio(total);
  const bortle = bortleFromSqm(sqm);
  const info = CLASSES[bortle];

  let main = null;
  if (total > 0 && best >= 0) {
    let j = -1;
    let dist = 0;
    if (c.nameIdx[best] >= 0) {
      j = best;
      dist = bestD;
    } else if (bestNamed >= 0 && bestNamedR / total >= MIN_NAMED_SHARE) {
      j = bestNamed;
      dist = bestNamedD;
    }
    if (j >= 0) {
      main = {
        name: c.names[c.nameIdx[j]],
        population: c.population[j],
        distanceKm: Math.round(dist),
        bearingDeg: bearingDeg(phi, lambda, latRad[j], lonRad[j]),
        share: round((j === best ? bestR : bestNamedR) / total, 2),
      };
    }
  }

  return {
    bortle,
    sqm: round(sqm, 1),
    ratio: round(total, 2),
    level: info.level,
    label: info.label,
    description: info.description,
    milkyWay: info.milkyWay,
    main,
    approximate: true,
  };
}
