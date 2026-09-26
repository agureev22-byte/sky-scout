// Спутники: загрузка TLE (CelesTrak → копия на сайте → кэш), расчёт положения по SGP4
// (satellite.js), освещённость Солнцем, треки и пролёты над наблюдателем.
// Модуль работает и в браузере, и в Node (тесты): зависимостей от DOM нет.
//
// Системы координат: SGP4 выдаёт положение в TEME (км). Вектор на Солнце берём из
// astronomy-engine (J2000) и поворачиваем к экватору даты — отличие от TEME ~1″,
// для теста тени Земли это несущественно.

import * as sat from '../vendor/satellite.js';
import * as A from '../vendor/astronomy.js';

// ---------------------------------------------------------------------------
// Константы и справочники

const CELESTRAK = 'https://celestrak.org/NORAD/elements/gp.php';

export const TLE_GROUPS = [
  { id: 'stations', title: 'Станции', url: `${CELESTRAK}?GROUP=stations&FORMAT=tle`, mirror: 'data/tle/stations.txt' },
  { id: 'visual', title: 'Яркие спутники', url: `${CELESTRAK}?GROUP=visual&FORMAT=tle`, mirror: 'data/tle/visual.txt' },
  { id: 'hubble', title: 'Хаббл', url: `${CELESTRAK}?CATNR=20580&FORMAT=tle`, mirror: 'data/tle/hubble.txt' },
  { id: 'starlink', title: 'Starlink', url: `${CELESTRAK}?GROUP=starlink&FORMAT=tle`, mirror: null },
];

// Главные объекты: показываются под русскими именами и помечаются featured.
export const FEATURED = { 25544: 'МКС', 20580: 'Хаббл', 48274: 'Тяньгун' };

// Порядок важности групп при удалении дублей (один спутник бывает в нескольких группах).
const GROUP_PRIORITY = ['stations', 'hubble', 'visual', 'starlink'];

// CelesTrak просит не скачивать одни и те же данные чаще раза в 2 часа: группу, успешно
// скачанную с CelesTrak менее 2 часов назад, не запрашиваем даже по кнопке «Обновить» (force).
export const TLE_MIN_INTERVAL_MS = 2 * 3600 * 1000;
// Данные с CelesTrak обновляем раз в 12 часов.
export const TLE_MAX_AGE_MS = 12 * 3600 * 1000;
// Данные из копии на сайте (data/tle) устаревают через 2 часа — затем снова пробуем CelesTrak.
export const TLE_MIRROR_MAX_AGE_MS = 2 * 3600 * 1000;
// Копия на сайте, где самая свежая орбита старше 7 суток, не заменяет более новый кэш;
// если новее ничего нет — принимается с пометкой sources[g].mirrorOutdated.
export const TLE_MIRROR_MAX_EPOCH_AGE_MS = 7 * 86400 * 1000;
// Пауза после неудачного запроса к CelesTrak (CelesTrak блокирует адреса, с которых идёт много
// ошибочных запросов); копию на сайте при этом всё равно пробуем. Действует и при force.
//  - HTTP-ошибка (403/429/5xx и прочие), неверный ответ, TypeError при наличии сети
//    (в браузере блокировка CelesTrak без CORS-заголовков тоже выглядит как TypeError): 30 минут;
//  - истекло время ожидания (AbortError/TimeoutError): 3 минуты;
//  - устройство без сети (navigator.onLine === false): ошибка не запоминается.
export const TLE_RETRY_AFTER_MS = 30 * 60 * 1000;
export const TLE_RETRY_AFTER_TIMEOUT_MS = 3 * 60 * 1000;

const CACHE_NAME = 'tle-data-v1'; // НЕ «sky-scout-…»: такие кэши удаляет сервис-воркер
const META_KEY = 'sky-scout:tle-meta-v1';
const LS_TEXT_PREFIX = 'sky-scout:tle-text-v1:';
const LS_TEXT_MAX = 400_000; // запасной вариант в localStorage — только для небольших групп

const KM_PER_AU = 149597870.7;
const EARTH_RADIUS_KM = 6378.137;
const SUN_RADIUS_KM = 695700;
const WGS84_A = 6378.137;
const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);
const WGS84_B = WGS84_A * (1 - WGS84_F);
const WGS84_EP2 = WGS84_E2 / (1 - WGS84_E2);
const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;
const TWO_PI = 2 * Math.PI;
const MS_PER_DAY = 86400000;
const JD_UNIX_EPOCH = 2440587.5;

const toMs = (d) => (typeof d === 'number' ? d : d instanceof Date ? d.getTime() : Date.parse(d));
const jdFromMs = (ms) => ms / MS_PER_DAY + JD_UNIX_EPOCH;

// ---------------------------------------------------------------------------
// Разбор TLE

// Контрольная сумма строки TLE: сумма цифр первых 68 символов, «минус» считается за 1, по модулю 10.
function tleChecksumOk(line) {
  let sum = 0;
  for (let i = 0; i < 68; i++) {
    const c = line.charCodeAt(i);
    if (c >= 48 && c <= 57) sum += c - 48;
    else if (c === 45) sum += 1;
  }
  return line.charCodeAt(68) - 48 === sum % 10;
}

// Номер NORAD, включая формат Alpha-5 (буква вместо первой цифры для номеров ≥ 100000).
function parseCatalogNumber(field) {
  const s = field.trim();
  if (/^\d{1,5}$/.test(s)) return Number(s);
  const m = /^([A-HJ-NP-Z])(\d{4})$/.exec(s);
  if (!m) return NaN;
  let v = m[1].charCodeAt(0) - 55; // A=10
  if (m[1] > 'I') v -= 1; // буква I пропущена
  if (m[1] > 'O') v -= 1; // буква O пропущена
  return v * 10000 + Number(m[2]);
}

const isLine1 = (l) => l.length >= 69 && l.charCodeAt(0) === 49 && l.charCodeAt(1) === 32;
const isLine2 = (l) => l.length >= 69 && l.charCodeAt(0) === 50 && l.charCodeAt(1) === 32;

const STATION_MODULES = {
  NAUKA: 'Наука',
  ZVEZDA: 'Звезда',
  POISK: 'Поиск',
  RASSVET: 'Рассвет',
  WENTIAN: 'Вэньтянь',
  MENGTIAN: 'Мэнтянь',
};

// Русские названия известных серий (применяются после отделения «R/B», «DEB»).
const NAME_RULES = [
  [/^ISS$/, 'МКС'],
  [/^PROGRESS[- ]MS[- ]?(\d+)$/, 'Прогресс МС-$1'],
  [/^SOYUZ[- ]MS[- ]?(\d+)$/, 'Союз МС-$1'],
  [/^(?:COSMOS|KOSMOS) (\d+)$/, 'Космос-$1'],
  [/^SHENZHOU-(\d+)(?: \(.*\))?$/, 'Шэньчжоу-$1'],
  [/^TIANZHOU-(\d+)$/, 'Тяньчжоу-$1'],
  [/^METEOR-M(\d)? ?(\d+)?$/, (_, a, b) => (a ? `Метеор-М № ${a}${b ? `-${b}` : ''}` : `Метеор-М${b ? ` № ${b}` : ''}`)],
  [/^RESURS-P ?(\d+)$/, 'Ресурс-П № $1'],
];

// Понятное русское имя спутника по имени из TLE.
function displayName(rawName, id) {
  if (FEATURED[id]) return FEATURED[id];
  let name = rawName;
  if (!name) return `Объект NORAD ${id}`;
  if (name.startsWith('STARLINK')) return name;

  // Модули станций (пристыкованы к МКС / Тяньгуну).
  let m = /^(ISS|CSS) \((.+)\)$/.exec(name);
  if (m) {
    const mod = STATION_MODULES[m[2]] || m[2];
    return `${m[1] === 'ISS' ? 'МКС' : 'Тяньгун'}: модуль «${mod}»`;
  }

  let suffix = '';
  if ((m = /\s+R\/B(\s*\(\d+\))?$/.exec(name))) {
    suffix = ' (ступень ракеты)';
    name = name.slice(0, m.index);
  } else if ((m = /\s+DEB$/.exec(name))) {
    suffix = ' (обломок)';
    name = name.slice(0, m.index);
  } else if ((m = /\s+AKM$/.exec(name))) {
    suffix = ' (разгонный двигатель)';
    name = name.slice(0, m.index);
  }

  for (const [re, rep] of NAME_RULES) {
    if (re.test(name)) {
      name = name.replace(re, rep);
      break;
    }
  }
  return name + suffix;
}

/**
 * Разбирает текст TLE (3-строчный формат «имя + 2 строки» или просто пары строк).
 * Битые записи (неверная длина, контрольная сумма, номер) молча пропускаются.
 * @returns {Array<{id:number,name:string,rawName:string,group:string,featured:boolean,
 *   satrec:object,epochMs:number,intlDes:string,inclDeg:number,revPerDay:number,periodMin:number,
 *   moduleOf:number|null}>}  moduleOf — NORAD станции, если это её модуль (МКС/Тяньгун)
 */
export function parseTle(text, group = '') {
  const out = [];
  if (typeof text !== 'string' || !text) return out;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length - 1; i++) {
    const l1 = lines[i].trimEnd();
    if (!isLine1(l1)) continue;
    const l2 = lines[i + 1].trimEnd();
    if (!isLine2(l2)) continue;
    // Имя — предыдущая строка, если это не строка элементов.
    let rawName = '';
    if (i > 0) {
      const prev = lines[i - 1].trim();
      if (prev && !isLine1(prev) && !isLine2(prev)) rawName = prev.replace(/^0 /, '');
    }
    i++; // строка 2 обработана
    if (!tleChecksumOk(l1) || !tleChecksumOk(l2)) continue;
    const id = parseCatalogNumber(l1.slice(2, 7));
    if (!Number.isFinite(id) || id !== parseCatalogNumber(l2.slice(2, 7))) continue;
    let satrec;
    try {
      satrec = sat.twoline2satrec(l1.slice(0, 69), l2.slice(0, 69));
    } catch {
      continue;
    }
    if (!satrec || satrec.error || !(satrec.no > 0) || !Number.isFinite(satrec.jdsatepoch)) continue;
    const revPerDay = parseFloat(l2.slice(52, 63));
    const cleanRaw = rawName.trim().replace(/\s+/g, ' ');
    const moduleOf = /^ISS \(/.test(cleanRaw) && id !== 25544 ? 25544 : /^CSS \(/.test(cleanRaw) && id !== 48274 ? 48274 : null;
    out.push({
      id,
      name: displayName(cleanRaw, id),
      rawName: cleanRaw,
      group,
      featured: Object.prototype.hasOwnProperty.call(FEATURED, id),
      satrec,
      epochMs: (satrec.jdsatepoch - JD_UNIX_EPOCH) * MS_PER_DAY,
      intlDes: l1.slice(9, 17).trim(),
      inclDeg: satrec.inclo * DEG,
      revPerDay,
      periodMin: 1440 / revPerDay,
      moduleOf,
    });
  }
  return out;
}

export function tleAgeDays(s, now = Date.now()) {
  return (toMs(now) - s.epochMs) / MS_PER_DAY;
}

// ---------------------------------------------------------------------------
// Наблюдатель, Солнце, тень Земли

/** Наблюдатель: широта/долгота в градусах, высота над уровнем моря в метрах. */
export function makeObserver(latDeg, lonDeg, heightM = 0) {
  const lat = latDeg * RAD;
  const lon = lonDeg * RAD;
  const hKm = (heightM || 0) / 1000;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const sinLon = Math.sin(lon);
  const cosLon = Math.cos(lon);
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  return {
    latDeg,
    lonDeg,
    heightM: heightM || 0,
    // Для функций satellite.js (радианы, км).
    latitude: lat,
    longitude: lon,
    height: hKm,
    sinLat,
    cosLat,
    sinLon,
    cosLon,
    // Положение в земной (ECEF) системе, км.
    x: (N + hKm) * cosLat * cosLon,
    y: (N + hKm) * cosLat * sinLon,
    z: (N * (1 - WGS84_E2) + hKm) * sinLat,
    astro: new A.Observer(latDeg, lonDeg, heightM || 0),
  };
}

/** Положение Солнца (геоцентрическое, экватор даты ≈ TEME), км. */
export function sunVectorKm(date) {
  const d = date instanceof Date ? date : new Date(toMs(date));
  const v = A.GeoVector(A.Body.Sun, d, true);
  const r = A.RotateVector(A.Rotation_EQJ_EQD(d), v);
  return { x: r.x * KM_PER_AU, y: r.y * KM_PER_AU, z: r.z * KM_PER_AU };
}

// Солнце смещается ~1°/сутки: для треков и пролётов достаточно пересчитывать раз в 10 минут.
const SUN_BUCKET_MS = 10 * 60 * 1000;
const sunCache = new Map();
function sunVectorCached(ms) {
  const b = Math.round(ms / SUN_BUCKET_MS);
  let v = sunCache.get(b);
  if (!v) {
    if (sunCache.size > 4000) sunCache.clear();
    v = sunVectorKm(b * SUN_BUCKET_MS);
    sunCache.set(b, v);
  }
  return v;
}

/**
 * Освещён ли объект Солнцем (не в конической тени Земли, умбре).
 * eciKm и sunKm — геоцентрические векторы в одной системе (TEME), км.
 */
export function isSunlit(eciKm, sunKm) {
  const sx = sunKm.x;
  const sy = sunKm.y;
  const sz = sunKm.z;
  const D = Math.sqrt(sx * sx + sy * sy + sz * sz);
  const ux = sx / D;
  const uy = sy / D;
  const uz = sz / D;
  const x = eciKm.x;
  const y = eciKm.y;
  const z = eciKm.z;
  const along = x * ux + y * uy + z * uz;
  if (along >= 0) return true; // дневная сторона
  const behind = -along; // расстояние за Землёй вдоль оси тени
  const px = x - along * ux;
  const py = y - along * uy;
  const pz = z - along * uz;
  const perp2 = px * px + py * py + pz * pz;
  // Конус умбры: полуугол sin α = (R☉ − R⊕)/D, вершина на расстоянии R⊕/sin α за Землёй.
  const sinA = (SUN_RADIUS_KM - EARTH_RADIUS_KM) / D;
  const tanA = sinA / Math.sqrt(1 - sinA * sinA);
  const umbraR = (EARTH_RADIUS_KM / sinA - behind) * tanA;
  if (umbraR <= 0) return true;
  return perp2 > umbraR * umbraR;
}

/** Общий для кадра контекст: звёздное время и Солнце считаются один раз на все спутники. */
export function frameContext(date) {
  const ms = toMs(date);
  const jd = jdFromMs(ms);
  return { date: new Date(ms), ms, jd, gmst: sat.gstime(jd), sunKm: sunVectorKm(ms) };
}

// ---------------------------------------------------------------------------
// Положение спутника

// Пропагация SGP4 на момент ms. Возвращает {position, velocity} (TEME, км, км/с) или null.
function propagateMs(satrec, ms) {
  const tsince = (jdFromMs(ms) - satrec.jdsatepoch) * 1440;
  let pv;
  try {
    pv = sat.sgp4(satrec, tsince);
  } catch {
    return null;
  }
  if (!pv || typeof pv.position !== 'object' || !pv.position) return null;
  if (satrec.tempa <= 0) return null; // давно сгоревший объект (проверка сообщества satellite.js)
  const p = pv.position;
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return null;
  return pv;
}

// Только высота над горизонтом, градусы (быстро, для поиска пролётов). NaN при ошибке.
function altitudeAt(satrec, observer, ms) {
  const pv = propagateMs(satrec, ms);
  if (!pv) return NaN;
  const g = sat.gstime(jdFromMs(ms));
  const cg = Math.cos(g);
  const sg = Math.sin(g);
  const p = pv.position;
  const rx = p.x * cg + p.y * sg - observer.x;
  const ry = -p.x * sg + p.y * cg - observer.y;
  const rz = p.z - observer.z;
  const up = observer.cosLat * (observer.cosLon * rx + observer.sinLon * ry) + observer.sinLat * rz;
  return Math.asin(up / Math.sqrt(rx * rx + ry * ry + rz * rz)) * DEG;
}

/**
 * Положение спутника для наблюдателя.
 * @param s     спутник из parseTle (или сам satrec)
 * @param date  Date или миллисекунды
 * @param ctx   необязательный кадровый контекст frameContext(date) — общий для всех спутников
 * @param out   необязательный объект для записи результата (без выделения памяти)
 * @returns null, если расчёт невозможен (сгорел / ошибка SGP4), иначе
 *   {az, alt, rangeKm, heightKm, speedKmS, sunlit, latDeg, lonDeg, eci:{x,y,z}}
 *   az — от севера через восток, alt — геометрическая (без рефракции), градусы.
 */
export function satPosition(s, date, observer, ctx, out) {
  const satrec = s.satrec || s;
  const ms = date == null && ctx ? ctx.ms : toMs(date);
  const pv = propagateMs(satrec, ms);
  if (!pv) return null;

  let gmst;
  let sunKm;
  if (ctx && (ctx.ms === undefined || Math.abs(ctx.ms - ms) <= 1000)) {
    gmst = ctx.gmst;
    sunKm = ctx.sunKm;
  } else {
    gmst = sat.gstime(jdFromMs(ms));
    sunKm = sunVectorCached(ms);
  }

  const p = pv.position;
  const v = pv.velocity;
  const cg = Math.cos(gmst);
  const sg = Math.sin(gmst);
  // TEME → ECEF (поворот на звёздное время).
  const ex = p.x * cg + p.y * sg;
  const ey = -p.x * sg + p.y * cg;
  const ez = p.z;
  // Вектор наблюдатель → спутник в топоцентрических осях (восток, север, зенит).
  const rx = ex - observer.x;
  const ry = ey - observer.y;
  const rz = ez - observer.z;
  const { sinLat, cosLat, sinLon, cosLon } = observer;
  const east = -sinLon * rx + cosLon * ry;
  const north = -sinLat * cosLon * rx - sinLat * sinLon * ry + cosLat * rz;
  const up = cosLat * cosLon * rx + cosLat * sinLon * ry + sinLat * rz;
  const range = Math.sqrt(rx * rx + ry * ry + rz * rz);
  let az = Math.atan2(east, north) * DEG;
  if (az < 0) az += 360;

  // Геодезические координаты подспутниковой точки (формула Боуринга, точность ~мм на НОО).
  const pxy = Math.sqrt(ex * ex + ey * ey);
  const th = Math.atan2(ez * WGS84_A, pxy * WGS84_B);
  const sth = Math.sin(th);
  const cth = Math.cos(th);
  const lat = Math.atan2(ez + WGS84_EP2 * WGS84_B * sth * sth * sth, pxy - WGS84_E2 * WGS84_A * cth * cth * cth);
  const sl = Math.sin(lat);
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sl * sl);
  const heightKm = pxy * Math.cos(lat) + ez * sl - (WGS84_A * WGS84_A) / N;

  const r = out || { eci: { x: 0, y: 0, z: 0 } };
  if (!r.eci) r.eci = { x: 0, y: 0, z: 0 };
  r.az = az;
  r.alt = Math.asin(up / range) * DEG;
  r.rangeKm = range;
  r.heightKm = heightKm;
  r.speedKmS = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  r.sunlit = isSunlit(p, sunKm);
  r.latDeg = lat * DEG;
  r.lonDeg = Math.atan2(ey, ex) * DEG;
  r.eci.x = p.x;
  r.eci.y = p.y;
  r.eci.z = p.z;
  return r;
}

/** Трек спутника по небу: точки [{t, az, alt, sunlit}] с шагом stepSec (ошибочные пропускаются). */
export function track(s, observer, fromMs, toMs_, stepSec = 20) {
  const from = toMs(fromMs);
  const to = toMs(toMs_);
  const step = Math.max(1, stepSec) * 1000;
  const pts = [];
  if (!(to >= from)) return pts;
  const n = Math.min(Math.floor((to - from) / step), 20000);
  const tmp = { eci: { x: 0, y: 0, z: 0 } };
  const add = (t) => {
    const pos = satPosition(s, t, observer, null, tmp);
    if (pos) pts.push({ t, az: pos.az, alt: pos.alt, sunlit: pos.sunlit });
  };
  for (let i = 0; i <= n; i++) add(from + i * step);
  if (from + n * step < to && n < 20000) add(to); // последняя точка — ровно конец интервала
  return pts;
}

// ---------------------------------------------------------------------------
// Пролёты

function defaultSunAltFn(observer) {
  const obs = observer.astro || new A.Observer(observer.latDeg, observer.lonDeg, observer.heightM || 0);
  return (ms) => {
    const d = new Date(ms);
    const eq = A.Equator(A.Body.Sun, d, obs, true, true);
    return A.Horizon(d, obs, eq.ra, eq.dec).altitude;
  };
}

/**
 * Ближайшие пролёты спутника над наблюдателем.
 * Пролёт — непрерывный интервал alt > 0 с максимальной высотой ≥ minAlt. Пролёт, идущий
 * в момент from, тоже возвращается (его rise в прошлом).
 * visible — есть момент, когда спутник выше 10°, освещён Солнцем, а у наблюдателя Солнце ниже −6°.
 * @param opts.sunAltFn (ms) → высота Солнца для наблюдателя, градусы (по умолчанию astronomy-engine)
 * @param opts.onlyVisible вернуть только видимые пролёты (maxPasses считается по ним)
 */
export function findPasses(
  s,
  observer,
  { from = Date.now(), days = 5, minAlt = 10, maxPasses = 12, sunAltFn, onlyVisible = false } = {},
) {
  const satrec = s.satrec || s;
  const start = toMs(from);
  const end = start + days * MS_PER_DAY;
  const STEP = 60000;
  const alt = (ms) => altitudeAt(satrec, observer, ms);
  const passes = [];
  if (!(maxPasses > 0) || !(end > start)) return passes;

  // Высота Солнца: считаем по минутным узлам с интерполяцией (Солнце движется ≤ 0,25°/мин).
  const rawSunAlt = sunAltFn || defaultSunAltFn(observer);
  const sunMemo = new Map();
  const sunNode = (k) => {
    let v = sunMemo.get(k);
    if (v === undefined) {
      v = rawSunAlt(k * 60000);
      sunMemo.set(k, v);
    }
    return v;
  };
  const sunAlt = (ms) => {
    const k = Math.floor(ms / 60000);
    const f = ms / 60000 - k;
    const a = sunNode(k);
    return f === 0 ? a : a + (sunNode(k + 1) - a) * f;
  };

  // Бисекция момента пересечения горизонта между lo (alt ≤ 0 для восхода) и hi.
  const crossing = (lo, hi, rising) => {
    while (hi - lo > 1000) {
      const mid = (lo + hi) / 2;
      const up = alt(mid) > 0;
      if (up === rising) hi = mid;
      else lo = mid;
    }
    return rising ? hi : lo;
  };
  // Золотое сечение для максимума высоты на [a, b].
  const G = (Math.sqrt(5) - 1) / 2;
  const maximum = (a, b) => {
    let c = b - G * (b - a);
    let d = a + G * (b - a);
    let fc = alt(c);
    let fd = alt(d);
    while (b - a > 1000) {
      if (fc > fd) {
        b = d;
        d = c;
        fd = fc;
        c = b - G * (b - a);
        fc = alt(c);
      } else {
        a = c;
        c = d;
        fc = fd;
        d = a + G * (b - a);
        fd = alt(d);
      }
    }
    return (a + b) / 2;
  };

  const tmp = { eci: { x: 0, y: 0, z: 0 } };
  const lookAt = (ms) => satPosition(s, ms, observer, null, tmp);

  const finishPass = (riseT, setT, peakCoarseT) => {
    const tMax = Math.round(maximum(Math.max(riseT, peakCoarseT - STEP), Math.min(setT, peakCoarseT + STEP)));
    riseT = Math.round(riseT);
    setT = Math.round(setT);
    const pMax = lookAt(tMax);
    if (!pMax || pMax.alt < minAlt) return;
    const maxInfo = { t: tMax, alt: pMax.alt, az: pMax.az };
    const pRise = lookAt(riseT);
    const riseInfo = { t: riseT, az: pRise ? pRise.az : NaN };
    const pSet = lookAt(setT);
    const setInfo = { t: setT, az: pSet ? pSet.az : NaN };

    // Видимость: проход по пролёту с шагом 5 с.
    let visibleFrom = null;
    let visibleTo = null;
    for (let t = riseT; t <= setT; t += 5000) {
      const p = lookAt(t);
      if (!p || p.alt < 10 || !p.sunlit) continue;
      if (sunAlt(t) >= -6) continue;
      if (visibleFrom === null) visibleFrom = t;
      visibleTo = t;
    }
    if (onlyVisible && visibleFrom === null) return;
    passes.push({
      rise: riseInfo,
      max: maxInfo,
      set: setInfo,
      visible: visibleFrom !== null,
      visibleFrom,
      visibleTo,
    });
  };

  let t = start;
  const a0 = alt(t);
  let prevUp = a0 > 0;
  let riseT = null;
  let peakT = 0;
  let peakAlt = -Infinity;

  if (prevUp) {
    // Пролёт уже идёт: ищем восход назад (не дальше 3 часов).
    let back = t;
    let found = false;
    for (let k = 0; k < 180; k++) {
      const a = alt(back - STEP);
      if (!(a > 0)) {
        riseT = crossing(back - STEP, back, true);
        found = true;
        break;
      }
      back -= STEP;
    }
    if (found) {
      peakT = t;
      peakAlt = a0;
      // Грубый максимум мог быть до start — пройдём от восхода.
      for (let u = riseT; u < t; u += STEP) {
        const a = alt(u);
        if (a > peakAlt) {
          peakAlt = a;
          peakT = u;
        }
      }
    }
    // Не нашли восход (геостационар или долгий пролёт) — текущий интервал пропускаем:
    // riseT остаётся null, prevUp = true, новый пролёт начнётся только после захода.
  }

  // Пролёт, начавшийся до конца окна, досчитываем до захода (но не дольше 3 часов).
  const hardEnd = end + 3 * 3600000;
  while ((t < end || riseT !== null) && t < hardEnd && passes.length < maxPasses) {
    const t2 = t + STEP;
    const a = alt(t2);
    const up = a > 0;
    if (riseT === null) {
      if (up && !prevUp) {
        riseT = crossing(t, t2, true);
        peakT = t2;
        peakAlt = a;
      }
    } else if (up) {
      if (a > peakAlt) {
        peakAlt = a;
        peakT = t2;
      }
    } else {
      // Заход (или ошибка расчёта — тогда конец интервала там, где ещё было видно).
      const setT = Number.isNaN(a) ? t : crossing(t, t2, false);
      if (peakAlt >= minAlt - 5) finishPass(riseT, setT, peakT);
      riseT = null;
      peakAlt = -Infinity;
    }
    prevUp = up;
    t = t2;
  }

  passes.sort((p, q) => p.rise.t - q.rise.t);
  return passes.slice(0, maxPasses);
}

// ---------------------------------------------------------------------------
// Хранилище TLE

/**
 * Хранилище по умолчанию: текст — в Cache Storage ('tle-data-v1'), время загрузки — в localStorage.
 * Если Cache Storage недоступно — текст небольших групп кладём в localStorage, иначе в память.
 * Интерфейс: {getText(group) → string|null, setText(group, text, fetchedAt),
 *   getMeta(group) → {fetchedAt, from?, netOkAt?, failedAt?, retryAfterMs?}|null, setMeta?(group, patch)}
 *   (методы могут возвращать Promise).
 * setText записывает meta заново ({fetchedAt}); setMeta (необязательный) дополняет её:
 *   from — откуда текст ('network' | 'mirror'), netOkAt — время последней успешной загрузки с CelesTrak,
 *   failedAt / retryAfterMs — время последней ошибки CelesTrak и пауза после неё.
 */
export function createDefaultStore() {
  const memText = new Map();
  const memMeta = {};
  const ls = (() => {
    try {
      return typeof localStorage !== 'undefined' ? localStorage : null;
    } catch {
      return null;
    }
  })();
  const readMeta = () => {
    try {
      const raw = ls && ls.getItem(META_KEY);
      return raw ? JSON.parse(raw) || {} : {};
    } catch {
      return {};
    }
  };
  const keyUrl = (group) => `https://tle-cache.invalid/${encodeURIComponent(group)}.txt`;
  const openCache = async () => {
    try {
      if (typeof caches === 'undefined') return null;
      return await caches.open(CACHE_NAME);
    } catch {
      return null;
    }
  };

  return {
    async getText(group) {
      const cache = await openCache();
      if (cache) {
        try {
          const res = await cache.match(keyUrl(group));
          if (res) return await res.text();
        } catch {
          /* кэш повреждён или недоступен */
        }
      }
      try {
        const t = ls && ls.getItem(LS_TEXT_PREFIX + group);
        if (t) return t;
      } catch {
        /* нет доступа */
      }
      return memText.get(group) ?? null;
    },
    async setText(group, text, fetchedAt) {
      memText.set(group, text);
      memMeta[group] = { fetchedAt };
      let saved = false;
      const cache = await openCache();
      if (cache) {
        try {
          await cache.put(
            keyUrl(group),
            new Response(text, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }),
          );
          saved = true;
        } catch {
          /* нет места */
        }
      }
      try {
        if (ls) {
          if (!saved && text.length <= LS_TEXT_MAX) ls.setItem(LS_TEXT_PREFIX + group, text);
          else if (saved) ls.removeItem(LS_TEXT_PREFIX + group);
          const meta = readMeta();
          meta[group] = { fetchedAt };
          ls.setItem(META_KEY, JSON.stringify(meta));
        }
      } catch {
        /* localStorage переполнен или запрещён */
      }
    },
    getMeta(group) {
      const meta = readMeta();
      return meta[group] || memMeta[group] || null;
    },
    setMeta(group, patch) {
      memMeta[group] = { ...(memMeta[group] || {}), ...patch };
      try {
        if (ls) {
          const meta = readMeta();
          meta[group] = { ...(meta[group] || {}), ...patch };
          ls.setItem(META_KEY, JSON.stringify(meta));
        }
      } catch {
        /* нет доступа */
      }
    },
  };
}

/**
 * Хранилище в памяти (для тестов и как запасной вариант).
 * initial: {group: {text, fetchedAt, ...прочие поля meta (from, netOkAt, failedAt, retryAfterMs)}}.
 */
export function createMemoryStore(initial = {}) {
  const text = new Map();
  const meta = new Map();
  for (const [g, { text: t, ...m }] of Object.entries(initial)) {
    text.set(g, t);
    meta.set(g, { ...m, fetchedAt: m.fetchedAt ?? null });
  }
  return {
    getText: (g) => text.get(g) ?? null,
    setText: (g, t, fetchedAt) => {
      text.set(g, t);
      meta.set(g, { fetchedAt });
    },
    getMeta: (g) => meta.get(g) ?? null,
    setMeta: (g, patch) => meta.set(g, { ...(meta.get(g) || {}), ...patch }),
  };
}

let defaultStore = null;

// ---------------------------------------------------------------------------
// Загрузка

function describeError(e) {
  if (!e) return 'неизвестная ошибка';
  if (e.name === 'AbortError' || e.name === 'TimeoutError') return 'нет ответа (истекло время ожидания)';
  if (e.userMessage) return e.userMessage;
  if (e instanceof TypeError) return 'нет связи или доступ запрещён браузером';
  return String(e.message || e);
}

// У самого устройства нет сети (браузер знает об этом точно только в эту сторону).
function deviceOffline() {
  try {
    const nav = globalThis.navigator;
    return !!nav && nav.onLine === false;
  } catch {
    return false;
  }
}

// Пауза перед следующим запросом к CelesTrak после ошибки e; 0 — ошибку не запоминать.
function retryDelayAfter(e) {
  if (deviceOffline()) return 0; // CelesTrak ни при чём — повторим, как только появится сеть
  if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) return TLE_RETRY_AFTER_TIMEOUT_MS;
  // HTTP 403/429/5xx, неверный ответ, TypeError при наличии сети (так же выглядит блокировка без CORS).
  return TLE_RETRY_AFTER_MS;
}

async function fetchTleText(fetchImpl, url, group, timeoutMs) {
  const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(url, ac ? { signal: ac.signal, cache: 'no-cache' } : { cache: 'no-cache' });
    if (!res || !res.ok) {
      const err = new Error(`HTTP ${res ? res.status : '?'}`);
      err.status = res ? res.status : 0;
      err.userMessage = res && res.status ? `сервер ответил ошибкой ${res.status}` : 'пустой ответ';
      throw err;
    }
    const text = await res.text();
    const sats = parseTle(text, group);
    if (!sats.length) {
      const err = new Error('no TLE in response');
      err.userMessage = 'в ответе нет данных TLE';
      throw err;
    }
    return { text, sats };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function resolveMirror(mirror, baseUrl) {
  const base = baseUrl ?? (typeof location !== 'undefined' ? location.href : null);
  if (!base) return mirror;
  try {
    return new URL(mirror, base).href;
  } catch {
    return mirror;
  }
}

const newestEpoch = (sats) => sats.reduce((m, s) => (s.epochMs > m ? s.epochMs : m), -Infinity);

// Самая старая и самая свежая эпоха орбит группы (null, если спутников нет).
function epochRange(sats) {
  let oldest = Infinity;
  let newest = -Infinity;
  for (const s of sats) {
    if (!Number.isFinite(s.epochMs)) continue;
    if (s.epochMs < oldest) oldest = s.epochMs;
    if (s.epochMs > newest) newest = s.epochMs;
  }
  return newest === -Infinity ? { oldest: null, newest: null } : { oldest, newest };
}

// Время последней успешной загрузки группы с CelesTrak (null — неизвестно).
// Старая meta (без поля from) писалась только при загрузке — считаем её загрузкой с CelesTrak.
function lastCelestrakOk(meta) {
  if (Number.isFinite(meta.netOkAt)) return meta.netOkAt;
  if (meta.from === undefined && Number.isFinite(meta.fetchedAt)) return meta.fetchedAt;
  return null;
}

function mergeGroups(parsed, groupIds) {
  const order = [...GROUP_PRIORITY.filter((g) => groupIds.includes(g)), ...groupIds.filter((g) => !GROUP_PRIORITY.includes(g))];
  const seen = new Set();
  const sats = [];
  for (const g of order) {
    for (const s of parsed[g] || []) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      sats.push(s);
    }
  }
  return sats;
}

/**
 * Загружает спутники: сначала сразу из кэша (onUpdate), затем обновляет устаревшие группы:
 * отсутствующие, скачанные с CelesTrak больше 12 ч назад, взятые из копии на сайте больше 2 ч назад
 * или все при force. Порядок: CelesTrak → копия на сайте (mirror) → остаётся кэш.
 * Бережём CelesTrak (даже при force):
 *  - группу, успешно скачанную с CelesTrak меньше 2 ч назад, не запрашиваем (sources[g].skippedFresh);
 *  - после ошибки CelesTrak выдерживаем паузу (TLE_RETRY_AFTER_MS / TLE_RETRY_AFTER_TIMEOUT_MS),
 *    отметка об ошибке сохраняется и тогда, когда данные пришли из копии на сайте.
 * @param opts.store     хранилище {getText, setText, getMeta, setMeta?} (по умолчанию Cache Storage + localStorage)
 * @param opts.baseUrl   относительно чего разрешать адрес копии (по умолчанию location.href)
 * @returns Promise<{sats, sources}>; sources[groupId] = {
 *   fetchedAt — когда данные скачаны (не возраст орбит!),
 *   from: 'network'|'mirror'|'cache'|null,
 *   error: строка, если свежие данные получить не удалось, networkError: ошибка CelesTrak (если была),
 *   count,
 *   skippedFresh: true — при force группа не запрашивалась: скачана с CelesTrak меньше 2 ч назад,
 *   mirrorOutdated: true — данные из копии на сайте, самая свежая орбита старше 7 суток,
 *   newestEpochMs / oldestEpochMs — самая свежая / самая старая эпоха орбит группы (мс) или null}
 */
export async function loadSatellites({
  groups = ['stations', 'visual', 'hubble', 'starlink'],
  force = false,
  onUpdate = null,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
  store = null,
  baseUrl = undefined,
  timeoutMs = 25000,
} = {}) {
  const st = store || (defaultStore ||= createDefaultStore());
  const defs = groups.map((id) => TLE_GROUPS.find((g) => g.id === id)).filter(Boolean);
  const ids = defs.map((d) => d.id);
  const parsed = {};
  const sources = {};
  const origin = {}; // откуда текущие данные группы: 'network' | 'mirror' | null
  const snapshot = () => ({
    sats: mergeGroups(parsed, ids),
    sources: Object.fromEntries(
      ids.map((g) => {
        const { newest, oldest } = epochRange(parsed[g]);
        const mirrorOutdated = origin[g] === 'mirror' && newest !== null && now - newest > TLE_MIRROR_MAX_EPOCH_AGE_MS;
        return [g, { ...sources[g], mirrorOutdated, newestEpochMs: newest, oldestEpochMs: oldest }];
      }),
    ),
  });
  const emit = (res) => {
    if (typeof onUpdate === 'function') {
      try {
        onUpdate(res);
      } catch (e) {
        console.error(e);
      }
    }
  };

  // (а) кэш
  const cachedText = {};
  const metaOf = {};
  await Promise.all(
    defs.map(async (d) => {
      let text = null;
      let meta = null;
      try {
        text = await st.getText(d.id);
        meta = await st.getMeta(d.id);
      } catch {
        /* хранилище недоступно */
      }
      const sats = text ? parseTle(text, d.id) : [];
      const m = meta && typeof meta === 'object' ? meta : {};
      metaOf[d.id] = m;
      cachedText[d.id] = sats.length ? text : null;
      parsed[d.id] = sats;
      origin[d.id] = sats.length ? (m.from === 'mirror' ? 'mirror' : 'network') : null;
      sources[d.id] = {
        fetchedAt: sats.length ? (Number.isFinite(m.fetchedAt) ? m.fetchedAt : null) : null,
        from: sats.length ? 'cache' : null,
        error: null,
        networkError: null,
        count: sats.length,
        skippedFresh: false,
      };
    }),
  );
  if (ids.some((g) => parsed[g].length)) emit(snapshot());

  // (б) обновление устаревших групп — параллельно, ошибки групп независимы
  const stale = defs.filter((d) => {
    const s = sources[d.id];
    const maxAge = origin[d.id] === 'mirror' ? TLE_MIRROR_MAX_AGE_MS : TLE_MAX_AGE_MS;
    return force || !cachedText[d.id] || !Number.isFinite(s.fetchedAt) || now - s.fetchedAt > maxAge || s.fetchedAt > now + 3600000;
  });
  if (!stale.length) return snapshot();

  await Promise.all(
    stale.map(async (d) => {
      const src = sources[d.id];
      const meta = metaOf[d.id];
      const netOkAt = lastCelestrakOk(meta);

      // С CelesTrak скачано меньше 2 ч назад — данные свежие, повторно не запрашиваем.
      if (cachedText[d.id] && netOkAt !== null && now >= netOkAt && now - netOkAt < TLE_MIN_INTERVAL_MS) {
        src.skippedFresh = true;
        return;
      }

      let got = null;
      let from = null;
      let netErr = null;
      let mirErr = null;
      // Ошибка CelesTrak, случившаяся после последней успешной загрузки с него.
      let failedAt = Number.isFinite(meta.failedAt) && !(netOkAt !== null && meta.failedAt <= netOkAt) ? meta.failedAt : null;
      let retryAfterMs = Number.isFinite(meta.retryAfterMs) && meta.retryAfterMs > 0 ? meta.retryAfterMs : TLE_RETRY_AFTER_MS;
      const backoff = failedAt !== null && now >= failedAt && now - failedAt < retryAfterMs;
      if (typeof fetchImpl === 'function') {
        if (backoff) {
          netErr = 'недавно был недоступен, повторим позже';
        } else {
          try {
            got = await fetchTleText(fetchImpl, d.url, d.id, timeoutMs);
            from = 'network';
          } catch (e) {
            netErr = describeError(e);
            const delay = retryDelayAfter(e);
            if (delay > 0) {
              failedAt = now;
              retryAfterMs = delay;
              try {
                await st.setMeta?.(d.id, { failedAt, retryAfterMs });
              } catch {
                /* не страшно */
              }
            }
          }
        }
        if (!got && d.mirror) {
          try {
            got = await fetchTleText(fetchImpl, resolveMirror(d.mirror, baseUrl), d.id, timeoutMs);
            from = 'mirror';
          } catch (e) {
            mirErr = describeError(e);
          }
        }
      } else {
        netErr = 'загрузка из сети недоступна';
      }

      // Копия на сайте может оказаться старее кэша — тогда оставляем кэш (в том числе
      // копию с орбитами старше 7 суток: её принимаем, только если новее ничего нет).
      if (got && from === 'mirror' && parsed[d.id].length && newestEpoch(got.sats) < newestEpoch(parsed[d.id])) {
        got = null;
        mirErr = 'копия на сайте старее сохранённых данных';
      }

      if (got) {
        parsed[d.id] = got.sats;
        origin[d.id] = from;
        src.fetchedAt = now;
        src.from = from;
        src.error = null;
        src.networkError = from === 'mirror' ? netErr : null;
        src.count = got.sats.length;
        // setText переписывает meta ({fetchedAt}); остальное дописываем следом. Для копии на сайте
        // сохраняем время последней загрузки с CelesTrak и отметку об ошибке — чтобы CelesTrak
        // спросили снова после обычной паузы, а не через 12 ч.
        const extra = { from };
        if (from === 'network') extra.netOkAt = now;
        else {
          if (netOkAt !== null) extra.netOkAt = netOkAt;
          if (failedAt !== null) Object.assign(extra, { failedAt, retryAfterMs });
        }
        try {
          await st.setText(d.id, got.text, now);
          await st.setMeta?.(d.id, extra);
        } catch {
          /* не сохранилось — не страшно */
        }
      } else {
        const parts = [`CelesTrak: ${netErr}`];
        if (d.mirror) parts.push(`копия на сайте: ${mirErr}`);
        src.error = parts.join('; ');
        src.networkError = netErr;
      }
    }),
  );

  const result = snapshot();
  emit(result);
  return result;
}
