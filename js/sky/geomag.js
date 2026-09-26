// Магнитное склонение по Мировой магнитной модели WMM2025 (NOAA NCEI + BGS).
// Нужно, чтобы компас iPhone (webkitCompassHeading — от магнитного севера) показывал
// направление на ИСТИННЫЙ север в любой точке Земли: истинный азимут = магнитный + склонение.
//
// Без зависимостей, работает и в браузере, и в Node. Коэффициенты WMM — общественное достояние
// (работа правительства США). Ниже — дословное содержимое официального файла WMM.COF
// (эпоха 2025.0, выпущен 13.11.2024, срок действия 2025.0–2030.0), взятое из пакета CIRES/NOAA
// wmm-calculator 1.4.4 (PyPI) и сверенное с npm-пакетами geomagnetism@0.2.0 и magvar@2.2.0.
// Колонки: n, m, g, h (нТл), g', h' (нТл/год).
//
// Алгоритм — как в отчёте WMM2025 и GeomagnetismLibrary.c: геодезические координаты WGS-84 →
// геоцентрические сферические, коэффициенты на нужную дату (линейная вековая вариация),
// присоединённые функции Лежандра с квазинормировкой Шмидта, компоненты поля X′/Y′/Z′
// в сферической системе, поворот обратно к геодезической вертикали, D = atan2(Y, X).

const WMM_COF = `
    2025.0            WMM-2025        11/13/2024
  1  0  -29351.8       0.0       12.0        0.0
  1  1   -1410.8    4545.4        9.7      -21.5
  2  0   -2556.6       0.0      -11.6        0.0
  2  1    2951.1   -3133.6       -5.2      -27.7
  2  2    1649.3    -815.1       -8.0      -12.1
  3  0    1361.0       0.0       -1.3        0.0
  3  1   -2404.1     -56.6       -4.2        4.0
  3  2    1243.8     237.5        0.4       -0.3
  3  3     453.6    -549.5      -15.6       -4.1
  4  0     895.0       0.0       -1.6        0.0
  4  1     799.5     278.6       -2.4       -1.1
  4  2      55.7    -133.9       -6.0        4.1
  4  3    -281.1     212.0        5.6        1.6
  4  4      12.1    -375.6       -7.0       -4.4
  5  0    -233.2       0.0        0.6        0.0
  5  1     368.9      45.4        1.4       -0.5
  5  2     187.2     220.2        0.0        2.2
  5  3    -138.7    -122.9        0.6        0.4
  5  4    -142.0      43.0        2.2        1.7
  5  5      20.9     106.1        0.9        1.9
  6  0      64.4       0.0       -0.2        0.0
  6  1      63.8     -18.4       -0.4        0.3
  6  2      76.9      16.8        0.9       -1.6
  6  3    -115.7      48.8        1.2       -0.4
  6  4     -40.9     -59.8       -0.9        0.9
  6  5      14.9      10.9        0.3        0.7
  6  6     -60.7      72.7        0.9        0.9
  7  0      79.5       0.0       -0.0        0.0
  7  1     -77.0     -48.9       -0.1        0.6
  7  2      -8.8     -14.4       -0.1        0.5
  7  3      59.3      -1.0        0.5       -0.8
  7  4      15.8      23.4       -0.1        0.0
  7  5       2.5      -7.4       -0.8       -1.0
  7  6     -11.1     -25.1       -0.8        0.6
  7  7      14.2      -2.3        0.8       -0.2
  8  0      23.2       0.0       -0.1        0.0
  8  1      10.8       7.1        0.2       -0.2
  8  2     -17.5     -12.6        0.0        0.5
  8  3       2.0      11.4        0.5       -0.4
  8  4     -21.7      -9.7       -0.1        0.4
  8  5      16.9      12.7        0.3       -0.5
  8  6      15.0       0.7        0.2       -0.6
  8  7     -16.8      -5.2       -0.0        0.3
  8  8       0.9       3.9        0.2        0.2
  9  0       4.6       0.0       -0.0        0.0
  9  1       7.8     -24.8       -0.1       -0.3
  9  2       3.0      12.2        0.1        0.3
  9  3      -0.2       8.3        0.3       -0.3
  9  4      -2.5      -3.3       -0.3        0.3
  9  5     -13.1      -5.2        0.0        0.2
  9  6       2.4       7.2        0.3       -0.1
  9  7       8.6      -0.6       -0.1       -0.2
  9  8      -8.7       0.8        0.1        0.4
  9  9     -12.9      10.0       -0.1        0.1
 10  0      -1.3       0.0        0.1        0.0
 10  1      -6.4       3.3        0.0        0.0
 10  2       0.2       0.0        0.1       -0.0
 10  3       2.0       2.4        0.1       -0.2
 10  4      -1.0       5.3       -0.0        0.1
 10  5      -0.6      -9.1       -0.3       -0.1
 10  6      -0.9       0.4        0.0        0.1
 10  7       1.5      -4.2       -0.1        0.0
 10  8       0.9      -3.8       -0.1       -0.1
 10  9      -2.7       0.9       -0.0        0.2
 10 10      -3.9      -9.1       -0.0       -0.0
 11  0       2.9       0.0        0.0        0.0
 11  1      -1.5       0.0       -0.0       -0.0
 11  2      -2.5       2.9        0.0        0.1
 11  3       2.4      -0.6        0.0       -0.0
 11  4      -0.6       0.2        0.0        0.1
 11  5      -0.1       0.5       -0.1       -0.0
 11  6      -0.6      -0.3        0.0       -0.0
 11  7      -0.1      -1.2       -0.0        0.1
 11  8       1.1      -1.7       -0.1       -0.0
 11  9      -1.0      -2.9       -0.1        0.0
 11 10      -0.2      -1.8       -0.1        0.0
 11 11       2.6      -2.3       -0.1        0.0
 12  0      -2.0       0.0        0.0        0.0
 12  1      -0.2      -1.3        0.0       -0.0
 12  2       0.3       0.7       -0.0        0.0
 12  3       1.2       1.0       -0.0       -0.1
 12  4      -1.3      -1.4       -0.0        0.1
 12  5       0.6      -0.0       -0.0       -0.0
 12  6       0.6       0.6        0.1       -0.0
 12  7       0.5      -0.1       -0.0       -0.0
 12  8      -0.1       0.8        0.0        0.0
 12  9      -0.4       0.1        0.0       -0.0
 12 10      -0.2      -1.0       -0.1       -0.0
 12 11      -1.3       0.1       -0.0        0.0
 12 12      -0.7       0.2       -0.1       -0.1
`;

const DEG = Math.PI / 180;
const N_MAX = 12;
const SIZE = ((N_MAX + 1) * (N_MAX + 2)) / 2; // индекс (n, m) → n(n+1)/2 + m
const RE = 6371.2; // геомагнитный опорный радиус, км
const WGS84_A = 6378.137; // большая полуось, км
const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);
// Ближе к полюсу широту не подпускаем (≈0,1 м): там 1/cos φ′ в Y′ даёт деление на ноль.
// Результат совпадает с пределом, который WMM считает отдельной веткой (MAG_SummationSpecial).
const MAX_LAT = 90 - 1e-6;

const G = new Float64Array(SIZE);
const H = new Float64Array(SIZE);
const GDOT = new Float64Array(SIZE);
const HDOT = new Float64Array(SIZE);

const cofLines = WMM_COF.trim().split('\n');
const [epochText, modelName, releaseText] = cofLines[0].trim().split(/\s+/);
for (const line of cofLines.slice(1)) {
  const [n, m, g, h, gd, hd] = line.trim().split(/\s+/).map(Number);
  const i = (n * (n + 1)) / 2 + m;
  G[i] = g;
  H[i] = h;
  GDOT[i] = gd;
  HDOT[i] = hd;
}
const EPOCH = Number(epochText);
const [relMonth, relDay, relYear] = releaseText.split('/');

/** Сведения о встроенной модели. */
export const WMM = Object.freeze({
  name: modelName, // 'WMM-2025'
  epoch: EPOCH, // 2025.0
  validFrom: EPOCH,
  validUntil: EPOCH + 5, // 2030.0; за пределами — линейная экстраполяция вековой вариации
  released: `${relYear}-${relMonth}-${relDay}`,
});

// Множители квазинормировки Шмидта для функций Лежандра в нормировке Гаусса.
const SCHMIDT = new Float64Array(SIZE);
SCHMIDT[0] = 1;
for (let n = 1; n <= N_MAX; n++) {
  const i0 = (n * (n + 1)) / 2;
  SCHMIDT[i0] = (SCHMIDT[((n - 1) * n) / 2] * (2 * n - 1)) / n;
  for (let m = 1; m <= n; m++) {
    SCHMIDT[i0 + m] = SCHMIDT[i0 + m - 1] * Math.sqrt(((n - m + 1) * (m === 1 ? 2 : 1)) / (n + m));
  }
}

// Рабочие массивы (модуль однопоточный, повторное использование безопасно).
const P = new Float64Array(SIZE);
const DP = new Float64Array(SIZE);
const COS_ML = new Float64Array(N_MAX + 1);
const SIN_ML = new Float64Array(N_MAX + 1);

/**
 * P[n,m](sin φ′) и dP/dφ′ с квазинормировкой Шмидта (рекурсия MAG_PcupLow).
 * @param {number} x sin φ′
 * @param {number} z cos φ′
 */
function legendre(x, z) {
  P[0] = 1;
  DP[0] = 0;
  for (let n = 1; n <= N_MAX; n++) {
    const i0 = (n * (n + 1)) / 2;
    const prev = ((n - 1) * n) / 2; // строка n−1
    const prev2 = ((n - 2) * (n - 1)) / 2; // строка n−2
    for (let m = 0; m <= n; m++) {
      const i = i0 + m;
      if (m === n) {
        const j = prev + m - 1;
        P[i] = z * P[j];
        DP[i] = z * DP[j] + x * P[j];
      } else if (m > n - 2) {
        // m = n − 1 (включая n = 1, m = 0): P[n−2, m] не существует
        const j = prev + m;
        P[i] = x * P[j];
        DP[i] = x * DP[j] - z * P[j];
      } else {
        const j = prev + m;
        const k = prev2 + m;
        const kk = ((n - 1) * (n - 1) - m * m) / ((2 * n - 1) * (2 * n - 3));
        P[i] = x * P[j] - kk * P[k];
        DP[i] = x * DP[j] - z * P[j] - kk * DP[k];
      }
    }
  }
  // Рекурсия даёт производную по кошироте θ; по широте φ′ = 90° − θ знак противоположный.
  for (let i = 0; i < SIZE; i++) {
    P[i] *= SCHMIDT[i];
    DP[i] = -DP[i] * SCHMIDT[i];
  }
}

/** Дата (Date или миллисекунды) → десятичный год в UTC, например 2025.5 ≈ 2 июля 2025. */
export function toDecimalYear(date) {
  const t = date instanceof Date ? date.getTime() : Number(date);
  if (!Number.isFinite(t)) return NaN;
  const y = new Date(t).getUTCFullYear();
  const start = new Date(0).setUTCFullYear(y, 0, 1);
  const end = new Date(0).setUTCFullYear(y + 1, 0, 1);
  return y + (t - start) / (end - start);
}

/**
 * Главное поле Земли по WMM на десятичный год.
 * @param {number} latDeg геодезическая широта, °
 * @param {number} lonDeg долгота, ° (восток +)
 * @param {number} altitudeKm высота над эллипсоидом WGS-84, км
 * @param {number} year десятичный год, например 2026.73
 * @returns {{x:number,y:number,z:number,h:number,f:number,incl:number,decl:number,year:number,extrapolated:boolean}}
 *   x — на север, y — на восток, z — вниз (нТл); incl, decl — наклонение и склонение, °.
 */
export function magneticFieldAtYear(latDeg, lonDeg, altitudeKm = 0, year) {
  latDeg = Number(latDeg);
  lonDeg = Number(lonDeg);
  altitudeKm = Number(altitudeKm ?? 0);
  year = Number(year);
  if (![latDeg, lonDeg, altitudeKm, year].every(Number.isFinite)) {
    return { x: NaN, y: NaN, z: NaN, h: NaN, f: NaN, incl: NaN, decl: NaN, year, extrapolated: true };
  }
  const lat = Math.max(-MAX_LAT, Math.min(MAX_LAT, latDeg)) * DEG;
  const lon = lonDeg * DEG;

  // Геодезические → геоцентрические сферические (WGS-84).
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const rc = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  const xp = (rc + altitudeKm) * cosLat;
  const zp = (rc * (1 - WGS84_E2) + altitudeKm) * sinLat;
  const r = Math.hypot(xp, zp);
  const phi = Math.atan2(zp, xp); // геоцентрическая широта φ′ (atan2 точнее asin у полюсов)
  const sinPhi = zp / r;
  const cosPhi = xp / r;

  legendre(sinPhi, cosPhi);
  for (let m = 0; m <= N_MAX; m++) {
    COS_ML[m] = Math.cos(m * lon);
    SIN_ML[m] = Math.sin(m * lon);
  }

  const dt = year - EPOCH;
  const ratio = RE / r;
  let rp = ratio * ratio; // (a/r)^(n+2), начиная с n = 0
  let bx = 0;
  let by = 0;
  let bz = 0;
  for (let n = 1; n <= N_MAX; n++) {
    rp *= ratio;
    const i0 = (n * (n + 1)) / 2;
    for (let m = 0; m <= n; m++) {
      const i = i0 + m;
      const g = G[i] + dt * GDOT[i];
      const h = H[i] + dt * HDOT[i];
      const gc = g * COS_ML[m] + h * SIN_ML[m];
      bx -= rp * gc * DP[i];
      by += rp * m * (g * SIN_ML[m] - h * COS_ML[m]) * P[i];
      bz -= rp * (n + 1) * gc * P[i];
    }
  }
  by /= cosPhi;

  // Поворот из сферической системы к геодезической вертикали.
  const psi = phi - lat;
  const x = bx * Math.cos(psi) - bz * Math.sin(psi);
  const z = bx * Math.sin(psi) + bz * Math.cos(psi);
  const y = by;
  const h = Math.hypot(x, y);
  return {
    x,
    y,
    z,
    h,
    f: Math.hypot(h, z),
    incl: Math.atan2(z, h) / DEG,
    decl: Math.atan2(y, x) / DEG,
    year,
    extrapolated: year < WMM.validFrom || year >= WMM.validUntil,
  };
}

/**
 * Главное поле Земли по WMM на момент времени.
 * @param {Date|number} date Date или миллисекунды Unix
 */
export function magneticField(latDeg, lonDeg, altitudeKm = 0, date = new Date()) {
  return magneticFieldAtYear(latDeg, lonDeg, altitudeKm, toDecimalYear(date));
}

/**
 * Магнитное склонение, градусы, восток положительный: истинный азимут = магнитный + склонение.
 * Диапазон (−180, 180]. Для некорректных входных данных — NaN.
 * @param {number} latDeg широта, °
 * @param {number} lonDeg долгота, ° (восток +)
 * @param {number} [altitudeKm=0] высота над эллипсоидом, км (для компаса разница с уровнем моря неважна)
 * @param {Date|number} [date=new Date()] момент времени
 */
export function magneticDeclination(latDeg, lonDeg, altitudeKm = 0, date = new Date()) {
  return magneticField(latDeg, lonDeg, altitudeKm, date).decl;
}
