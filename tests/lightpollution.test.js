import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  prepareCities,
  estimateLightPollution,
  sqmFromRatio,
  bortleFromSqm,
  loadCities,
} from '../js/lightpollution.js';

const raw = JSON.parse(readFileSync(new URL('../data/cities.json', import.meta.url), 'utf8'));
const cities = prepareCities(raw);

const est = (lat, lon, set = cities) => estimateLightPollution(lat, lon, set);

test('data/cities.json has the expected format', () => {
  assert.equal(raw.v, 1);
  assert.equal(raw.minPopulation, 5000);
  assert.equal(raw.d.length, raw.count * 3);
  assert.equal(raw.names.length, raw.namedCount);
  assert.ok(raw.count > 40000, `count = ${raw.count}`);
  assert.ok(raw.namedCount > 10000 && raw.namedCount < raw.count);
  assert.ok(raw.d.every(Number.isInteger));
  assert.match(raw.source, /GeoNames/);
  // Sorted by population, descending.
  for (let i = 5; i < raw.d.length; i += 3) assert.ok(raw.d[i] <= raw.d[i - 3]);
});

test('Madrid centre: city sky, main source is Madrid', () => {
  const r = est(40.4168, -3.7038);
  assert.ok(r.bortle >= 8, `bortle = ${r.bortle}`);
  assert.equal(r.main?.name, 'Madrid');
  assert.ok(r.main.distanceKm <= 2);
  assert.ok(r.main.population > 3e6);
});

test('Barcelona centre: city sky', () => {
  const r = est(41.3874, 2.1686);
  assert.ok(r.bortle >= 8, `bortle = ${r.bortle}`);
  assert.equal(r.main?.name, 'Barcelona');
});

test('Paris centre: city sky', () => {
  const r = est(48.8566, 2.3522);
  assert.ok(r.bortle >= 8, `bortle = ${r.bortle}`);
});

test('Montsec observatory: dark sky', () => {
  const r = est(42.0517, 0.7294);
  assert.ok(r.bortle <= 3, `bortle = ${r.bortle}, sqm = ${r.sqm}`);
  assert.ok(r.sqm >= 21.2);
});

test('~30 km NW of Madrid: in between', () => {
  const r = est(40.6, -4.02);
  assert.ok(r.bortle >= 4 && r.bortle <= 7, `bortle = ${r.bortle}`);
});

test('mid-Atlantic: pristine sky, no source', () => {
  const r = est(0, -30);
  assert.equal(r.bortle, 1);
  assert.equal(r.sqm, 22);
  assert.equal(r.ratio, 0);
  assert.equal(r.main, null);
  assert.equal(r.level, 'excellent');
  assert.equal(r.milkyWay, 'good');
});

test('antimeridian: Suva (Fiji) is not dropped', () => {
  const r = est(-18.14, 178.44);
  assert.ok(r.bortle >= 5, `bortle = ${r.bortle}`);
  assert.equal(r.main?.name, 'Suva');

  // East of ±180, Suva lies to the west across the antimeridian.
  const e = est(-18.14, -179.5);
  assert.equal(e.bortle, 1);
  assert.equal(e.main?.name, 'Suva');
  assert.ok(Math.abs(e.main.distanceKm - 218) <= 3, `distance = ${e.main.distanceKm}`);
  assert.ok(e.main.bearingDeg >= 260 && e.main.bearingDeg <= 280, `bearing = ${e.main.bearingDeg}`);

  // Point at lon −179.9 near Labasa (179.36°E): no crash.
  const l = est(-16.43, -179.9);
  assert.ok(l.bortle >= 1 && l.bortle <= 9);
});

test('antimeridian with a synthetic city: same result from both sides', () => {
  const set = prepareCities({ v: 1, count: 1, namedCount: 1, d: [0, 17995, 1000], names: ['Восток'] });
  const west = est(0, -179.95, set); // 0.1° ≈ 11 km across ±180
  const east = est(0, 179.85, set); // 0.1° ≈ 11 km, same side
  assert.ok(west.ratio > 1, `ratio = ${west.ratio}`);
  assert.equal(west.ratio, east.ratio);
  assert.equal(west.main.name, 'Восток');
  assert.equal(west.main.distanceKm, 11);
  assert.equal(west.main.bearingDeg, 270);
  assert.equal(east.main.bearingDeg, 90);
});

test('near the North Pole: no crash, dark sky; cities across the pole are found', () => {
  const r = est(89.9, 0);
  assert.equal(r.bortle, 1);
  assert.equal(r.main, null);

  // Synthetic city on the opposite meridian, 0.6° (~67 km) away across the pole.
  const set = prepareCities({ v: 1, count: 1, namedCount: 1, d: [8950, 10000, 500], names: ['Полюс'] });
  const p = est(89.9, -80, set);
  assert.ok(p.ratio > 0.05, `ratio = ${p.ratio}`);
  assert.equal(p.main.name, 'Полюс');
  assert.equal(p.main.distanceKm, 67);
  assert.equal(p.main.bearingDeg, 0);
});

test('main falls back to a named city only with a big enough share', () => {
  // Named city (40k) and an anonymous town (20k, index 1 >= namedCount)
  // 1° of longitude (~85 km) apart on the same parallel.
  const d = [
    4050, 1100, 40, // "Город" at (40.50, 11.00)
    4050, 1000, 20, // anonymous town at (40.50, 10.00)
  ];
  const set = prepareCities({ v: 1, count: 2, namedCount: 1, d, names: ['Город'] });
  // 10 km from the town: the town dominates, the city's share is tiny.
  const nearTown = est(40.5, 10.118, set);
  assert.equal(nearTown.main, null);
  // 30 km from the town, 55 km from the city: town still strongest, but the
  // city has ~30 % of the glow -> it is reported.
  const between = est(40.5, 10.355, set);
  assert.equal(between.main?.name, 'Город');
  assert.ok(between.main.share >= 0.15 && between.main.share < 0.5, `share = ${between.main.share}`);
  assert.equal(between.main.bearingDeg, 90);
  // Near the city itself it is simply the strongest source.
  assert.equal(est(40.5, 11.02, set).main?.name, 'Город');
});

test('sqmFromRatio and bortleFromSqm', () => {
  assert.equal(sqmFromRatio(0), 22.0);
  assert.ok(Math.abs(sqmFromRatio(9) - 19.5) < 1e-12);
  assert.equal(bortleFromSqm(22), 1);
  assert.equal(bortleFromSqm(21.76), 1);
  assert.equal(bortleFromSqm(21.75), 2);
  assert.equal(bortleFromSqm(21.6), 2);
  assert.equal(bortleFromSqm(21.59), 3);
  assert.equal(bortleFromSqm(21.25), 3);
  assert.equal(bortleFromSqm(21.24), 4);
  assert.equal(bortleFromSqm(20.3), 4);
  assert.equal(bortleFromSqm(20.29), 5);
  assert.equal(bortleFromSqm(19.25), 5);
  assert.equal(bortleFromSqm(19.24), 6);
  assert.equal(bortleFromSqm(18.5), 6);
  assert.equal(bortleFromSqm(18.49), 7);
  assert.equal(bortleFromSqm(18.0), 7);
  assert.equal(bortleFromSqm(17.99), 8);
  assert.equal(bortleFromSqm(17.5), 8);
  assert.equal(bortleFromSqm(17.4), 9);
});

test('result shape', () => {
  const levels = ['excellent', 'dark', 'rural', 'transition', 'suburban', 'bright-suburban', 'urban', 'city'];
  const milky = ['good', 'visible', 'faint', 'camera', 'none'];
  for (const [lat, lon] of [[40.4168, -3.7038], [42.0517, 0.7294], [40.6, -4.02], [0, -30], [55.75, 37.62]]) {
    const r = est(lat, lon);
    assert.deepEqual(
      Object.keys(r).sort(),
      ['approximate', 'bortle', 'description', 'label', 'level', 'main', 'milkyWay', 'ratio', 'sqm'],
    );
    assert.ok(Number.isInteger(r.bortle) && r.bortle >= 1 && r.bortle <= 9);
    assert.equal(typeof r.sqm, 'number');
    assert.equal(r.sqm, Math.round(r.sqm * 10) / 10);
    assert.equal(r.ratio, Math.round(r.ratio * 100) / 100);
    assert.ok(levels.includes(r.level));
    assert.ok(milky.includes(r.milkyWay));
    assert.equal(typeof r.label, 'string');
    assert.ok(r.label.length > 0);
    assert.equal(typeof r.description, 'string');
    assert.ok(r.description.length > 0);
    assert.equal(r.approximate, true);
    if (r.main) {
      assert.deepEqual(Object.keys(r.main).sort(), ['bearingDeg', 'distanceKm', 'name', 'population', 'share']);
      assert.equal(typeof r.main.name, 'string');
      assert.ok(Number.isInteger(r.main.distanceKm));
      assert.ok(Number.isInteger(r.main.bearingDeg) && r.main.bearingDeg >= 0 && r.main.bearingDeg < 360);
      assert.ok(r.main.share > 0 && r.main.share <= 1);
    }
  }
  assert.throws(() => est(NaN, 0), TypeError);
});

test('performance: one call well under 10 ms', () => {
  const pts = [];
  for (let i = 0; i < 2000; i++) {
    // Deterministic spread over populated latitudes, plus dense Europe.
    pts.push([-50 + ((i * 37) % 120), -180 + ((i * 131) % 360)]);
    pts.push([45 + (i % 10) * 0.7, (i % 13) * 0.9]);
  }
  est(40, 0); // warm-up
  const t0 = performance.now();
  for (const [lat, lon] of pts) est(lat, lon);
  const perCall = (performance.now() - t0) / pts.length;
  console.log(`# estimateLightPollution: ${perCall.toFixed(3)} ms per call (${cities.count} cities)`);
  assert.ok(perCall < 10, `${perCall} ms per call`);
});

test('loadCities reads the dataset (file: URL in Node) and caches it', async () => {
  const a = await loadCities();
  const b = await loadCities();
  assert.equal(a, b);
  assert.equal(a.count, raw.count);
});

test('loadCities rejects with an Error on failure', async () => {
  await assert.rejects(loadCities(new URL('../data/does-not-exist.json', import.meta.url)), Error);
});
