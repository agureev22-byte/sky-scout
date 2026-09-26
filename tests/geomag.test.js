// Checks js/sky/geomag.js (WMM2025 magnetic declination) against NOAA's published test values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  magneticDeclination,
  magneticField,
  magneticFieldAtYear,
  toDecimalYear,
  WMM,
} from '../js/sky/geomag.js';

// Row: [decimal year, height above WGS-84 ellipsoid km, geodetic lat °, lon °, X nT, Y nT, Z nT, incl °, decl °]

// Official test-value table from the WMM2025 technical report
// (CIRES-Geomagnetism/wmm, tests/WMM2025_TEST_VALUE_TABLE_FOR_REPORT.txt). X/Y/Z rounded to 0.1 nT.
const REPORT_TABLE = [
  [2025, 0, 80, 0, 6521.6, 145.9, 54791.5, 83.21, 1.28],
  [2025, 0, 0, 120, 39677.8, -109.6, -10580.2, -14.93, -0.16],
  [2025, 0, -80, 240, 6117.5, 15751.9, -52022.5, -72, 68.78],
  [2025, 100, 80, 0, 6216, 92.4, 52598.8, 83.26, 0.85],
  [2025, 100, 0, 120, 37688.6, -96.2, -10152.1, -15.08, -0.15],
  [2025, 100, -80, 240, 5907.6, 14780.3, -49540.7, -72.19, 68.21],
  [2027.5, 0, 80, 0, 6500.8, 294.5, 54869.4, 83.24, 2.59],
  [2027.5, 0, 0, 120, 39701.6, -167.4, -10381.8, -14.65, -0.24],
  [2027.5, 0, -80, 240, 6200.7, 15730.3, -51783.7, -71.92, 68.49],
  [2027.5, 100, 80, 0, 6196.7, 233.8, 52670.5, 83.29, 2.16],
  [2027.5, 100, 0, 120, 37711.5, -148.7, -9969.8, -14.81, -0.23],
  [2027.5, 100, -80, 240, 5984, 14760.1, -49317.7, -72.1, 67.93],
];

// NOAA WMM2025 test values, 100 points for 2025.0–2029.5 (as shipped in geomagnetism@0.2.0,
// test/values.csv). X/Y/Z rounded here to 0.1 nT; angles are published to 0.01°.
const NOAA_100 = [
  [2025, 28, 89, -121, -255.4, -1482.5, 56194.3, 88.47, -99.77],
  [2025, 48, 80, -96, 1876.0, -1079.3, 55623.0, 87.77, -29.91],
  [2025, 54, 82, 87, 1324.3, 1883.4, 56740.8, 87.68, 54.89],
  [2025, 65, 43, 93, 24299.9, 210.5, 50037.9, 64.1, 0.5],
  [2025, 51, -33, 109, 21737.8, -2090.3, -52710.0, -67.5, -5.49],
  [2025, 39, -59, -8, 14358.1, -4049.1, -24389.1, -58.55, -15.75],
  [2025, 3, -50, -103, 19526.5, 10363.0, -31437.6, -54.89, 27.96],
  [2025, 94, -29, -110, 23275.5, 6559.0, -19063.6, -38.25, 15.74],
  [2025, 66, 14, 143, 35003.4, -116.6, 7966.3, 12.82, -0.19],
  [2025, 18, 0, 21, 29274.8, 659.8, -14316.7, -26.06, 1.29],
  [2025.5, 6, -36, -137, 23781.9, 8786.7, -32577.5, -52.11, 20.28],
  [2025.5, 63, 26, 81, 34802.6, 308.4, 30332.1, 41.07, 0.51],
  [2025.5, 69, 38, -144, 22510.8, 5167.6, 35526.0, 56.97, 12.93],
  [2025.5, 50, -70, -133, 9021.8, 14001.9, -51084.8, -71.94, 57.21],
  [2025.5, 8, -52, -75, 19331.9, 5147.8, -23532.7, -49.63, 14.91],
  [2025.5, 8, -66, 17, 15201.4, -9925.5, -30881.1, -59.55, -33.14],
  [2025.5, 22, -37, 140, 21404.8, 3498.9, -55397.6, -68.62, 9.28],
  [2025.5, 40, -12, -129, 28594.5, 5432.2, -8052.5, -15.46, 10.76],
  [2025.5, 44, 33, -118, 23235.8, 4558.4, 37727.7, 57.89, 11.1],
  [2025.5, 50, -81, -67, 16132.7, 8623.5, -44412.3, -67.61, 28.13],
  [2026, 74, -57, 3, 13268.1, -5498.2, -23576.1, -58.65, -22.51],
  [2026, 46, -24, -122, 25846.1, 6448.9, -18080.4, -34.17, 14.01],
  [2026, 69, 23, 63, 34558.6, 708.1, 25043.4, 35.92, 1.17],
  [2026, 33, -3, -147, 30514.1, 5221.8, -1147.0, -2.12, 9.71],
  [2026, 47, -72, -22, 18280.8, -2024.1, -33397.5, -61.16, -6.32],
  [2026, 62, -14, 99, 33437.8, -835.9, -33100.9, -44.7, -1.43],
  [2026, 83, 86, -46, 2582.1, -1527.8, 54279.3, 86.84, -30.61],
  [2026, 82, -64, 87, 2007.1, -13829.4, -53663.5, -75.4, -81.74],
  [2026, 34, -19, 43, 19525.7, -5224.0, -26182.9, -52.33, -14.98],
  [2026, 56, -81, 40, 9000.5, -15446.9, -45267.9, -68.45, -59.77],
  [2026.5, 14, 0, 80, 39431.4, -2133.5, -12188.8, -17.15, -3.1],
  [2026.5, 12, -82, -68, 16052.8, 9190.4, -45940.1, -68.07, 29.79],
  [2026.5, 44, -46, -42, 13863.2, -2785.8, -19744.3, -54.39, -11.36],
  [2026.5, 43, 17, 52, 35994.9, 747.9, 15990.9, 23.95, 1.19],
  [2026.5, 64, 10, 78, 39427.7, -1050.0, 5214.8, 7.53, -1.53],
  [2026.5, 12, 33, -145, 24136.8, 5112.2, 32162.9, 52.51, 11.96],
  [2026.5, 12, -79, 115, -9613.7, -8785.7, -58104.3, -77.37, -137.58],
  [2026.5, 14, -33, -114, 23393.1, 7653.1, -23854.3, -44.1, 18.12],
  [2026.5, 19, 29, 66, 32725.0, 1278.3, 33958.5, 46.04, 2.24],
  [2026.5, 86, -11, 167, 32578.4, 5882.8, -20368.2, -31.6, 10.24],
  [2027, 37, -66, -5, 16390.8, -5079.6, -28608.2, -59.04, -17.22],
  [2027, 67, 72, -115, 4883.3, 1192.9, 55689.6, 84.84, 13.73],
  [2027, 44, 22, 174, 28684.0, 3249.9, 17961.2, 31.89, 6.46],
  [2027, 54, 54, 178, 20615.9, 225.0, 45149.6, 65.46, 0.63],
  [2027, 57, -43, 50, 11203.7, -12563.4, -33221.4, -63.13, -48.27],
  [2027, 44, -43, -111, 20471.5, 9245.5, -29347.6, -52.57, 24.31],
  [2027, 12, -63, 178, 6233.8, 9925.5, -61075.7, -79.14, 57.87],
  [2027, 38, 27, -169, 25821.1, 3851.7, 24058.4, 42.66, 8.48],
  [2027, 61, 59, -77, 10437.8, -3087.4, 54397.7, 78.68, -16.48],
  [2027, 67, -47, -32, 12450.8, -2994.1, -20475.3, -57.98, -13.52],
  [2027.5, 8, 62, 53, 12260.4, 4315.5, 54849.8, 76.67, 19.39],
  [2027.5, 77, -68, -7, 16578.1, -4813.7, -29680.4, -59.82, -16.19],
  [2027.5, 98, -5, 159, 33545.0, 4589.7, -14525.8, -23.22, 7.79],
  [2027.5, 34, -29, -107, 23540.4, 6592.4, -18723.1, -37.45, 15.64],
  [2027.5, 60, 27, 65, 33062.2, 1068.6, 30667.4, 42.83, 1.85],
  [2027.5, 73, -72, 95, -2912.4, -12984.1, -55399.2, -76.49, -102.64],
  [2027.5, 96, -46, -85, 18947.7, 6129.6, -21631.4, -47.37, 17.93],
  [2027.5, 0, -13, -59, 21365.8, -6732.6, -6112.3, -15.26, -17.49],
  [2027.5, 16, 66, -178, 13821.3, 89.2, 54092.6, 75.67, 0.37],
  [2027.5, 72, -87, 38, 6926.1, -15153.9, -48295.6, -70.97, -65.44],
  [2028, 49, 20, 167, 30131.4, 2689.9, 15295.6, 26.82, 5.1],
  [2028, 71, 5, -13, 28142.6, -3193.0, -9017.9, -17.66, -6.47],
  [2028, 95, 14, 65, 36932.5, -329.9, 11601.2, 17.44, -0.51],
  [2028, 86, -85, -79, 12713.1, 11085.5, -46988.3, -70.25, 41.09],
  [2028, 30, -36, -64, 17341.3, -1411.1, -14640.0, -40.08, -4.65],
  [2028, 75, 79, 125, 2447.6, -823.2, 57308.8, 87.42, -18.59],
  [2028, 21, 6, -32, 27567.1, -7045.0, -4352.0, -8.7, -14.34],
  [2028, 1, -76, -75, 16993.7, 9761.1, -42479.8, -65.23, 29.87],
  [2028, 45, -46, -41, 13610.0, -2812.6, -19816.2, -54.96, -11.68],
  [2028, 11, -22, -21, 12430.6, -5338.0, -21373.8, -57.67, -23.24],
  [2028.5, 28, 54, -120, 14735.1, 4067.0, 52393.7, 73.74, 15.43],
  [2028.5, 68, -58, 156, 6945.0, 6159.6, -62264.4, -81.52, 41.57],
  [2028.5, 39, -65, -88, 17946.9, 10131.7, -35982.9, -60.2, 29.45],
  [2028.5, 27, -23, 81, 24940.7, -5883.9, -41948.7, -58.58, -13.27],
  [2028.5, 11, 34, 0, 29078.2, 798.4, 30945.6, 46.77, 1.57],
  [2028.5, 72, -62, 65, 6567.9, -16150.4, -44267.3, -68.5, -67.87],
  [2028.5, 55, 86, 70, 901.7, 2192.1, 55926.2, 87.57, 67.64],
  [2028.5, 59, 32, 163, 28217.1, 75.2, 26405.9, 43.1, 0.15],
  [2028.5, 65, 48, 148, 23365.2, -3931.0, 44177.6, 61.79, -9.55],
  [2028.5, 95, 30, 28, 29692.1, 2368.0, 29039.8, 44.27, 4.56],
  [2029, 95, -60, -59, 17893.0, 2700.1, -26011.8, -55.17, 8.58],
  [2029, 95, -70, 42, 10426.2, -14920.8, -38237.0, -64.54, -55.06],
  [2029, 50, 87, -154, 257.9, -869.5, 55992.3, 89.07, -73.48],
  [2029, 58, 32, 19, 29359.4, 2108.2, 30508.5, 46.03, 4.11],
  [2029, 57, 34, -13, 28241.9, -933.2, 28997.5, 45.74, -1.89],
  [2029, 38, -76, 49, 7991.1, -16588.2, -44151.3, -67.36, -64.28],
  [2029, 49, -50, -179, 15315.0, 9610.3, -53522.7, -71.33, 32.11],
  [2029, 90, -55, -171, 12821.5, 10252.4, -52995.1, -72.79, 38.65],
  [2029, 41, 42, -19, 24440.0, -1762.9, 36929.9, 56.44, -4.13],
  [2029, 19, 46, -22, 22522.1, -2227.4, 40651.7, 60.89, -5.65],
  [2029.5, 31, 13, -132, 27795.6, 4421.1, 17188.0, 31.41, 9.04],
  [2029.5, 93, -2, 158, 33806.5, 4207.2, -10964.6, -17.84, 7.09],
  [2029.5, 51, -76, 40, 10263.7, -15412.8, -42018.5, -66.22, -56.34],
  [2029.5, 64, 22, -132, 25601.3, 4620.0, 24914.4, 43.76, 10.23],
  [2029.5, 26, -65, 55, 8347.2, -16728.9, -41431.5, -65.71, -63.48],
  [2029.5, 66, -21, 32, 15578.3, -4066.4, -24494.9, -56.68, -14.63],
  [2029.5, 18, 9, -172, 30521.0, 4966.9, 8779.5, 15.85, 9.24],
  [2029.5, 63, 88, 26, 2041.1, 1511.6, 55286.6, 87.37, 36.52],
  [2029.5, 33, 17, 5, 34022.0, 531.4, 8341.1, 13.77, 0.89],
  [2029.5, 77, -18, 138, 31751.5, 2472.3, -34817.4, -47.55, 4.45],
];

const DECL_TOL = 0.05; // °, required tolerance
const ANGLE_TOL = 0.011; // °, published values are rounded to 0.01°
const NT_TOL = 1; // nT

function checkRows(rows) {
  for (const [year, alt, lat, lon, x, y, z, incl, decl] of rows) {
    const where = `${year} ${lat},${lon} h=${alt} km`;
    const r = magneticFieldAtYear(lat, lon, alt, year);
    assert.ok(Math.abs(r.decl - decl) <= DECL_TOL, `${where}: decl ${r.decl} vs ${decl}`);
    assert.ok(Math.abs(r.decl - decl) <= ANGLE_TOL, `${where}: decl ${r.decl} vs ${decl} (rounding)`);
    assert.ok(Math.abs(r.incl - incl) <= ANGLE_TOL, `${where}: incl ${r.incl} vs ${incl}`);
    assert.ok(Math.abs(r.x - x) <= NT_TOL, `${where}: X ${r.x} vs ${x}`);
    assert.ok(Math.abs(r.y - y) <= NT_TOL, `${where}: Y ${r.y} vs ${y}`);
    assert.ok(Math.abs(r.z - z) <= NT_TOL, `${where}: Z ${r.z} vs ${z}`);
    assert.equal(r.extrapolated, false, where);
  }
}

/** Decimal year → Date (UTC), same convention as toDecimalYear. */
function dateOfYear(year) {
  const y = Math.floor(year);
  const start = Date.UTC(y, 0, 1);
  return new Date(start + (year - y) * (Date.UTC(y + 1, 0, 1) - start));
}

test('model metadata: WMM2025, epoch 2025.0, valid until 2030.0', () => {
  assert.equal(WMM.name, 'WMM-2025');
  assert.equal(WMM.epoch, 2025);
  assert.equal(WMM.validFrom, 2025);
  assert.equal(WMM.validUntil, 2030);
  assert.equal(WMM.released, '2024-11-13');
});

test('WMM2025 report test table: both hemispheres, 0 and 100 km, 2025.0 and 2027.5', () => {
  assert.equal(REPORT_TABLE.length, 12);
  checkRows(REPORT_TABLE);
});

test('NOAA WMM2025 100-point test values (2025.0–2029.5, 0–98 km, incl. near-pole points)', () => {
  assert.equal(NOAA_100.length, 100);
  assert.ok(NOAA_100.some((r) => r[2] >= 85) && NOAA_100.some((r) => r[2] <= -85), 'covers polar caps');
  checkRows(NOAA_100);
});

test('Date-based API agrees with decimal-year API', () => {
  for (const row of [REPORT_TABLE[6], NOAA_100[20], NOAA_100[57], NOAA_100[99]]) {
    const [year, alt, lat, lon, , , , , decl] = row;
    const date = dateOfYear(year);
    assert.ok(Math.abs(toDecimalYear(date) - year) < 1e-9, `toDecimalYear ${year}`);
    const d = magneticDeclination(lat, lon, alt, date);
    assert.ok(Math.abs(d - decl) <= DECL_TOL, `${year} ${lat},${lon}: ${d} vs ${decl}`);
    assert.equal(magneticField(lat, lon, alt, date.getTime()).decl, d, 'Date and ms timestamp');
  }
});

test('toDecimalYear', () => {
  assert.equal(toDecimalYear(new Date(Date.UTC(2025, 0, 1))), 2025);
  assert.equal(toDecimalYear(new Date(Date.UTC(2025, 6, 2, 12))), 2025.5); // 182.5 days of 365
  assert.equal(toDecimalYear(new Date(Date.UTC(2028, 6, 2))), 2028.5); // leap year: 183 of 366
  assert.ok(Number.isNaN(toDecimalYear(new Date('invalid'))));
});

test('Barcelona 2026: small positive (east) declination', () => {
  const d = magneticDeclination(41.39, 2.17, 0, new Date(Date.UTC(2026, 5, 1)));
  assert.ok(d > 1 && d < 2.5, `Barcelona: ${d}`);
  // defaults: altitude 0, current date
  assert.ok(Number.isFinite(magneticDeclination(41.39, 2.17)));
});

test('sign convention and rough values for well-known places (Sept 2026)', () => {
  const date = new Date(Date.UTC(2026, 8, 15));
  const within = (lat, lon, lo, hi, what) => {
    const d = magneticDeclination(lat, lon, 0, date);
    assert.ok(d >= lo && d <= hi, `${what}: ${d} not in [${lo}, ${hi}]`);
  };
  within(55.76, 37.62, 11, 13.5, 'Moscow (east)');
  within(34.05, -118.24, 10.5, 12.5, 'Los Angeles (east)');
  within(-33.87, 151.21, 12, 14, 'Sydney (east)');
  within(40.71, -74.01, -13.5, -11.5, 'New York (west)');
  within(48.86, 2.35, 1, 3, 'Paris');
});

test('geographic poles: finite, continuous, and meridian-dependent', () => {
  const date = new Date(Date.UTC(2026, 8, 15));
  for (const lat of [90, -90, 89.9999, -89.9999, 89.99999999]) {
    for (const lon of [-180, -135, 0, 45, 90, 180, 359]) {
      for (const alt of [0, 10, 400]) {
        const f = magneticField(lat, lon, alt, date);
        for (const k of ['x', 'y', 'z', 'h', 'f', 'incl', 'decl']) {
          assert.ok(Number.isFinite(f[k]), `${k} at ${lat},${lon},${alt}`);
        }
        assert.ok(f.decl > -180 && f.decl <= 180);
      }
    }
  }
  // At the pole "north" is the direction along the chosen meridian, so D shifts with longitude.
  const d0 = magneticDeclination(90, 0, 0, date);
  const d90 = magneticDeclination(90, 90, 0, date);
  assert.ok(Math.abs(((d90 - d0 - 90 + 540) % 360) - 180) < 1e-4, `${d0} → ${d90}`);
  assert.ok(Math.abs(magneticDeclination(89.9999, 0, 0, date) - d0) < 0.01);
  assert.ok(Math.abs(magneticDeclination(-89.9999, 0, 0, date) - magneticDeclination(-90, 0, 0, date)) < 0.01);
});

test('longitude wrap-around', () => {
  const date = new Date(Date.UTC(2027, 0, 1));
  assert.ok(Math.abs(magneticDeclination(-33, 240, 0, date) - magneticDeclination(-33, -120, 0, date)) < 1e-9);
  assert.ok(Math.abs(magneticDeclination(10, 180, 0, date) - magneticDeclination(10, -180, 0, date)) < 1e-9);
});

test('outside 2025–2030 the model is extrapolated but still returns numbers', () => {
  const inside = magneticFieldAtYear(41.39, 2.17, 0, 2026.7);
  const after = magneticFieldAtYear(41.39, 2.17, 0, 2031.5);
  const before = magneticFieldAtYear(41.39, 2.17, 0, 2024.5);
  assert.equal(inside.extrapolated, false);
  assert.equal(after.extrapolated, true);
  assert.equal(before.extrapolated, true);
  assert.ok(Number.isFinite(after.decl) && Math.abs(after.decl - inside.decl) < 2);
});

test('invalid input gives NaN, not an exception', () => {
  assert.ok(Number.isNaN(magneticDeclination(NaN, 0)));
  assert.ok(Number.isNaN(magneticDeclination(40, undefined)));
  assert.ok(Number.isNaN(magneticDeclination(40, 3, 0, new Date('invalid'))));
  assert.ok(Number.isNaN(magneticDeclination(40, 3, Infinity, new Date())));
});
