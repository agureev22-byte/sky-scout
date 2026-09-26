// Тесты модуля спутников.
// ВНИМАНИЕ: tests/fixtures/tle-test.txt — СИНТЕТИЧЕСКИЕ элементы орбит (похожие на МКС, Хаббл,
// Тяньгун, Starlink и ступень SL-16, эпоха 2026, сутки 268 ≈ 25.09.2026 12:00 UTC). Это не реальные
// TLE: контрольные суммы вычислены программно, орбиты подобраны только для проверки расчётов.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as sat from '../vendor/satellite.js';
import {
  TLE_GROUPS,
  FEATURED,
  parseTle,
  loadSatellites,
  createMemoryStore,
  makeObserver,
  sunVectorKm,
  isSunlit,
  satPosition,
  frameContext,
  track,
  findPasses,
  tleAgeDays,
  TLE_MIN_INTERVAL_MS,
  TLE_MAX_AGE_MS,
  TLE_MIRROR_MAX_AGE_MS,
  TLE_MIRROR_MAX_EPOCH_AGE_MS,
  TLE_RETRY_AFTER_MS,
  TLE_RETRY_AFTER_TIMEOUT_MS,
} from '../js/satellites.js';

const FIXTURE = readFileSync(new URL('./fixtures/tle-test.txt', import.meta.url), 'utf8');
const DEG = 180 / Math.PI;
const barcelona = makeObserver(41.39, 2.17, 0);
const T0 = Date.UTC(2026, 8, 26, 0, 0, 0);

// Независимая проверка контрольной суммы (не из тестируемого модуля).
function checksum(line) {
  let sum = 0;
  for (const ch of line.slice(0, 68)) {
    if (ch >= '0' && ch <= '9') sum += Number(ch);
    else if (ch === '-') sum += 1;
  }
  return sum % 10;
}

const byId = (list, id) => list.find((s) => s.id === id);

test('fixture: correct TLE layout and checksums', () => {
  const lines = FIXTURE.trim().split('\n');
  assert.equal(lines.length, 15);
  for (let i = 0; i < lines.length; i += 3) {
    const [, l1, l2] = lines.slice(i, i + 3);
    assert.equal(l1.length, 69);
    assert.equal(l2.length, 69);
    assert.equal(Number(l1[68]), checksum(l1));
    assert.equal(Number(l2[68]), checksum(l2));
    assert.equal(l1.slice(18, 32), '26268.50000000');
  }
});

test('parseTle: 5 satellites, featured Russian names, cleaned names', () => {
  const sats = parseTle(FIXTURE, 'test');
  assert.equal(sats.length, 5);
  assert.deepEqual(
    sats.map((s) => s.id),
    [25544, 20580, 48274, 44713, 22220],
  );
  assert.equal(byId(sats, 25544).name, 'МКС');
  assert.equal(byId(sats, 20580).name, 'Хаббл');
  assert.equal(byId(sats, 48274).name, 'Тяньгун');
  assert.equal(byId(sats, 25544).rawName, 'ISS (ZARYA)');
  assert.equal(byId(sats, 44713).name, 'STARLINK-1007');
  assert.equal(byId(sats, 22220).name, 'SL-16 (ступень ракеты)');
  assert.equal(byId(sats, 22220).rawName, 'SL-16 R/B');
  for (const s of sats) {
    assert.equal(s.group, 'test');
    assert.equal(s.featured, s.id in FEATURED);
    assert.equal(s.epochMs, Date.UTC(2026, 8, 25, 12, 0, 0));
    assert.ok(s.satrec && s.satrec.no > 0);
  }
  assert.ok(Math.abs(byId(sats, 25544).inclDeg - 51.64) < 1e-9);
  assert.ok(Math.abs(byId(sats, 25544).periodMin - 1440 / 15.5) < 0.01);
  assert.equal(byId(sats, 25544).intlDes, '98067A');
  assert.ok(Math.abs(tleAgeDays(byId(sats, 25544), T0) - 0.5) < 1e-9);
});

test('parseTle: 2-line format, CRLF, debris names, junk is skipped', () => {
  const lines = FIXTURE.trim().split('\n');
  // Только пары строк, без имён, с CRLF.
  const twoLine = [lines[1], lines[2], lines[4], lines[5]].join('\r\n');
  const sats = parseTle(twoLine, 'g');
  assert.equal(sats.length, 2);
  assert.equal(sats[0].name, 'МКС');
  assert.equal(sats[1].name, 'Хаббл');
  assert.equal(parseTle(lines.slice(9, 12).join('\n').replace('STARLINK-1007', 'FENGYUN 1C DEB'))[0].name, 'FENGYUN 1C (обломок)');
  assert.equal(parseTle(lines.slice(9, 12).join('\n').replace('STARLINK-1007', 'COSMOS 2251 DEB'))[0].name, 'Космос-2251 (обломок)');
  assert.equal(parseTle(lines.slice(9, 12).join('\n').replace('STARLINK-1007', '0 CZ-4C R/B'))[0].name, 'CZ-4C (ступень ракеты)');
  assert.deepEqual(parseTle(''), []);
  assert.deepEqual(parseTle('No GP data found'), []);
  assert.deepEqual(parseTle(null), []);
});

test('parseTle: bad checksum or mismatched lines are rejected', () => {
  const lines = FIXTURE.trim().split('\n');
  // Меняем цифру наклонения МКС, контрольную сумму не трогаем.
  const broken = lines[2].replace(' 51.6400 ', ' 51.6500 ');
  assert.notEqual(broken, lines[2]);
  const text = [lines[0], lines[1], broken, ...lines.slice(3)].join('\n');
  const sats = parseTle(text);
  assert.equal(sats.length, 4);
  assert.equal(byId(sats, 25544), undefined);
  // Строка 2 от другого спутника.
  assert.equal(parseTle([lines[0], lines[1], lines[5]].join('\n')).length, 0);
  // Обрезанная строка.
  assert.equal(parseTle([lines[0], lines[1], lines[2].slice(0, 60)].join('\n')).length, 0);
});

test('satPosition: ISS-like height, speed, ranges; matches satellite.js reference transforms', () => {
  const sats = parseTle(FIXTURE, 'test');
  const iss = byId(sats, 25544);
  for (let k = 0; k < 24; k++) {
    const date = new Date(T0 + k * 7 * 60000);
    const p = satPosition(iss, date, barcelona);
    assert.ok(p, 'position');
    assert.ok(p.heightKm > 400 && p.heightKm < 450, `height ${p.heightKm}`);
    assert.ok(p.speedKmS > 7.5 && p.speedKmS < 7.8, `speed ${p.speedKmS}`);
    assert.ok(p.az >= 0 && p.az < 360);
    assert.ok(p.alt >= -90 && p.alt <= 90);
    assert.ok(p.latDeg >= -52 && p.latDeg <= 52, `lat ${p.latDeg}`); // геодезическая широта чуть больше наклонения
    assert.ok(p.lonDeg >= -180 && p.lonDeg <= 180);
    assert.equal(typeof p.sunlit, 'boolean');

    // Эталон — функции satellite.js.
    const pv = sat.propagate(iss.satrec, date);
    const gmst = sat.gstime(date);
    const la = sat.ecfToLookAngles(barcelona, sat.eciToEcf(pv.position, gmst));
    const geo = sat.eciToGeodetic(pv.position, gmst);
    const dAz = Math.abs(((p.az - la.azimuth * DEG + 540) % 360) - 180);
    assert.ok(dAz < 1e-6, `az ${p.az} vs ${la.azimuth * DEG}`);
    assert.ok(Math.abs(p.alt - la.elevation * DEG) < 1e-6);
    assert.ok(Math.abs(p.rangeKm - la.rangeSat) < 1e-6);
    assert.ok(Math.abs(p.heightKm - geo.height) < 1e-3);
    assert.ok(Math.abs(p.latDeg - geo.latitude * DEG) < 1e-6);
    assert.ok(Math.abs(p.lonDeg - geo.longitude * DEG) < 1e-6);
  }
  // Кадровый контекст и объект out дают тот же результат.
  const ctx = frameContext(T0);
  const out = {};
  const a = satPosition(iss, T0, barcelona);
  const b = satPosition(iss, T0, barcelona, ctx, out);
  assert.equal(b, out);
  assert.equal(a.az, b.az);
  assert.equal(a.sunlit, b.sunlit);
  // Все спутники фикстуры считаются, высоты правдоподобные.
  const heights = { 20580: [460, 510], 48274: [370, 420], 44713: [530, 580], 22220: [800, 870] };
  for (const [id, [lo, hi]] of Object.entries(heights)) {
    const p = satPosition(byId(sats, Number(id)), T0, barcelona, ctx);
    assert.ok(p.heightKm > lo && p.heightKm < hi, `${id}: ${p.heightKm}`);
  }
});

test('satPosition: returns null for a decayed orbit', () => {
  const lines = FIXTURE.trim().split('\n');
  const [s] = parseTle(lines.slice(0, 3).join('\n'));
  // Через 10 лет с таким торможением орбита давно «сгорела».
  const p = satPosition(s, Date.UTC(2036, 0, 1), barcelona);
  assert.equal(p, null);
  assert.deepEqual(track(s, barcelona, Date.UTC(2036, 0, 1), Date.UTC(2036, 0, 1, 1)), []);
});

test('sunVectorKm: ~1 AU and agrees with satellite.js low-precision Sun', () => {
  const s = sunVectorKm(new Date(T0));
  const r = Math.hypot(s.x, s.y, s.z);
  assert.ok(r > 1.47e8 && r < 1.53e8, `r=${r}`);
  const ref = sat.sunPos(sat.jday(new Date(T0))).rsun;
  const rr = Math.hypot(ref.x, ref.y, ref.z);
  const cos = (s.x * ref.x + s.y * ref.y + s.z * ref.z) / (r * rr);
  const angle = Math.acos(Math.min(1, cos)) * DEG;
  assert.ok(angle < 0.05, `angle ${angle}°`);
  // Близко к равноденствию: склонение Солнца около нуля.
  assert.ok(Math.abs(Math.asin(s.z / r) * DEG) < 2);
});

test('isSunlit: day side lit, directly behind Earth in shadow', () => {
  const sun = sunVectorKm(new Date(T0));
  const r = Math.hypot(sun.x, sun.y, sun.z);
  const u = { x: sun.x / r, y: sun.y / r, z: sun.z / r };
  const at = (k) => ({ x: u.x * k, y: u.y * k, z: u.z * k });
  assert.equal(isSunlit(at(6800), sun), true);
  assert.equal(isSunlit(at(-6800), sun), false);
  assert.equal(isSunlit(at(-42164), sun), false); // геостационар в тени (близко к равноденствию)
  // Перпендикулярно направлению на Солнце — освещён.
  const perp = { x: -u.y, y: u.x, z: 0 };
  const pn = Math.hypot(perp.x, perp.y);
  assert.equal(isSunlit({ x: (perp.x / pn) * 6800, y: (perp.y / pn) * 6800, z: 0 }, sun), true);
  // Позади Земли, но в стороне дальше радиуса Земли — освещён.
  assert.equal(isSunlit({ x: -u.x * 7000 + (perp.x / pn) * 6500, y: -u.y * 7000 + (perp.y / pn) * 6500, z: -u.z * 7000 }, sun), true);
  // За пределами вершины конуса умбры (> 1,4 млн км) тени нет.
  assert.equal(isSunlit(at(-2e6), sun), true);
});

test('satellites fly through both light and shadow over an orbit', () => {
  const iss = byId(parseTle(FIXTURE), 25544);
  const pts = track(iss, barcelona, T0, T0 + 93 * 60000, 30);
  assert.ok(pts.length >= 186);
  assert.ok(pts.some((p) => p.sunlit));
  assert.ok(pts.some((p) => !p.sunlit));
  const lit = pts.filter((p) => p.sunlit).length / pts.length;
  assert.ok(lit > 0.5 && lit < 0.8, `lit fraction ${lit}`);
  for (let i = 1; i < pts.length; i++) assert.ok(pts[i].t > pts[i - 1].t);
  assert.equal(pts.at(-1).t, T0 + 93 * 60000);
  assert.ok(pts.every((p) => Object.keys(p).join() === 't,az,alt,sunlit'));
});

test('findPasses: Barcelona, ISS-like orbit, 5 days', () => {
  const iss = byId(parseTle(FIXTURE), 25544);
  const t = performance.now();
  const passes = findPasses(iss, barcelona, { from: T0, days: 5 });
  const ms = performance.now() - t;
  assert.ok(ms < 300, `findPasses took ${ms.toFixed(1)} ms`);
  assert.ok(passes.length >= 1);
  assert.ok(passes.length <= 12);
  for (const p of passes) {
    assert.ok(p.rise.t < p.max.t && p.max.t < p.set.t);
    assert.ok(p.max.alt >= 10);
    assert.ok(p.rise.t >= T0);
    const dur = (p.set.t - p.rise.t) / 60000;
    assert.ok(dur > 3 && dur < 12, `duration ${dur} min`);
    // Восход и заход уточнены до секунды: высота там около нуля.
    assert.ok(Math.abs(satPosition(iss, p.rise.t, barcelona).alt) < 0.2);
    assert.ok(Math.abs(satPosition(iss, p.set.t, barcelona).alt) < 0.2);
    // Максимум действительно максимум.
    const top = satPosition(iss, p.max.t, barcelona).alt;
    assert.ok(Math.abs(top - p.max.alt) < 1e-9);
    assert.ok(satPosition(iss, p.max.t - 20000, barcelona).alt < top);
    assert.ok(satPosition(iss, p.max.t + 20000, barcelona).alt < top);
    for (const k of ['rise', 'max', 'set']) assert.ok(p[k].az >= 0 && p[k].az < 360);
    if (p.visible) {
      assert.ok(p.visibleFrom >= p.rise.t && p.visibleTo <= p.set.t && p.visibleFrom <= p.visibleTo);
      const v = satPosition(iss, p.visibleFrom, barcelona);
      assert.ok(v.sunlit && v.alt >= 10);
    } else {
      assert.equal(p.visibleFrom, null);
      assert.equal(p.visibleTo, null);
    }
  }
  for (let i = 1; i < passes.length; i++) assert.ok(passes[i].rise.t > passes[i - 1].set.t);
  // С синтетической орбитой есть вечерние видимые пролёты (Солнце ниже −6°, МКС освещена).
  const visible = passes.filter((p) => p.visible);
  assert.ok(visible.length >= 1);
  const onlyVisible = findPasses(iss, barcelona, { from: T0, days: 5, onlyVisible: true, maxPasses: 3 });
  assert.equal(onlyVisible.length, 3);
  assert.ok(onlyVisible.every((p) => p.visible));
  assert.equal(onlyVisible[0].rise.t, visible[0].rise.t);
  // Своя функция высоты Солнца: «всегда ночь» — видимы все пролёты с освещённым спутником выше 10°.
  const night = findPasses(iss, barcelona, { from: T0, days: 1, sunAltFn: () => -30 });
  assert.ok(night.filter((p) => p.visible).length >= visible.filter((p) => p.rise.t < T0 + 86400000).length);
  // Высокий порог — только высокие пролёты.
  assert.ok(findPasses(iss, barcelona, { from: T0, days: 5, minAlt: 60 }).every((p) => p.max.alt >= 60));
});

test('findPasses: pass in progress at "from" is returned with rise in the past', () => {
  const iss = byId(parseTle(FIXTURE), 25544);
  const [first] = findPasses(iss, barcelona, { from: T0, days: 2 });
  const mid = first.max.t;
  const [cur] = findPasses(iss, barcelona, { from: mid, days: 1 });
  assert.ok(Math.abs(cur.rise.t - first.rise.t) < 2000);
  assert.ok(Math.abs(cur.set.t - first.set.t) < 2000);
  assert.ok(cur.rise.t < mid);
});

test('findPasses: no passes for an orbit that never rises (Hubble-like, far north)', () => {
  const hst = byId(parseTle(FIXTURE), 20580);
  assert.deepEqual(findPasses(hst, makeObserver(69.65, 18.96), { from: T0, days: 2 }), []);
});

// ---------------------------------------------------------------------------
// loadSatellites

const lines = FIXTURE.trim().split('\n');
const tle = (...idx) => idx.map((i) => lines.slice(i * 3, i * 3 + 3).join('\n')).join('\n') + '\n';
const TEXT = {
  stations: tle(0, 2), // МКС, Тяньгун
  hubble: tle(1),
  visual: tle(0, 1, 4), // МКС и Хаббл тоже есть в «ярких» — дубли
  starlink: tle(3, 0), // дубль МКС (для проверки приоритета)
};
const EPOCH = Date.UTC(2026, 8, 25, 12); // эпоха всех орбит фикстуры (26268.5)

// Меняет эпоху в строках 1 (поле из 14 символов, например '26260.50000000') и пересчитывает контрольную сумму.
const retime = (text, epoch) =>
  text
    .split('\n')
    .map((l) => {
      if (!l.startsWith('1 ')) return l;
      const body = l.slice(0, 18) + epoch + l.slice(32, 68);
      return body + checksum(body);
    })
    .join('\n');

// Временно подменяет globalThis.navigator (в Node 21+ это настраиваемый геттер).
async function withNavigator(value, fn) {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
  try {
    return await fn();
  } finally {
    if (desc) Object.defineProperty(globalThis, 'navigator', desc);
    else delete globalThis.navigator;
  }
}
const isNet = (u) => u.startsWith('https://celestrak.org/');

function fakeFetch(routes, calls = []) {
  return async (url) => {
    calls.push(url);
    const r = routes(url);
    if (r instanceof Error) throw r;
    if (!r) return { ok: false, status: 404, text: async () => 'Not found' };
    return { ok: r.status ? r.status === 200 : true, status: r.status ?? 200, text: async () => r.body };
  };
}
const groupOf = (url) => {
  if (url.startsWith('https://celestrak.org/')) {
    const g = /GROUP=(\w+)/.exec(url)?.[1] ?? (url.includes('CATNR=20580') ? 'hubble' : null);
    return { net: true, g };
  }
  const m = /data\/tle\/(\w+)\.txt$/.exec(url);
  return { net: false, g: m && m[1] };
};

test('TLE_GROUPS: expected ids, urls and mirrors', () => {
  assert.deepEqual(
    TLE_GROUPS.map((g) => g.id),
    ['stations', 'visual', 'hubble', 'starlink'],
  );
  for (const g of TLE_GROUPS) {
    assert.match(g.url, /^https:\/\/celestrak\.org\/NORAD\/elements\/gp\.php\?(GROUP=\w+|CATNR=20580)&FORMAT=tle$/);
    assert.ok(g.title);
  }
  assert.equal(TLE_GROUPS.find((g) => g.id === 'starlink').mirror, null);
  assert.equal(TLE_GROUPS.find((g) => g.id === 'hubble').mirror, 'data/tle/hubble.txt');
});

test('loadSatellites: network ok → from network, cached, deduped by group priority', async () => {
  const store = createMemoryStore();
  const updates = [];
  const calls = [];
  const now = T0;
  const res = await loadSatellites({
    store,
    now,
    fetchImpl: fakeFetch((url) => {
      const { net, g } = groupOf(url);
      return net ? { body: TEXT[g] } : null;
    }, calls),
    onUpdate: (r) => updates.push(r),
  });
  assert.equal(calls.length, 4);
  assert.ok(calls.every((u) => u.startsWith('https://celestrak.org/')));
  assert.equal(updates.length, 1); // кэша не было — только итоговый вызов
  assert.equal(updates[0], res);
  for (const g of ['stations', 'visual', 'hubble', 'starlink']) {
    assert.equal(res.sources[g].from, 'network');
    assert.equal(res.sources[g].fetchedAt, now);
    assert.equal(res.sources[g].error, null);
    assert.equal(res.sources[g].skippedFresh, false);
    assert.equal(res.sources[g].mirrorOutdated, false);
    assert.equal(res.sources[g].newestEpochMs, EPOCH);
    assert.equal(res.sources[g].oldestEpochMs, EPOCH);
    assert.equal(store.getMeta(g).fetchedAt, now);
    assert.equal(store.getMeta(g).from, 'network');
    assert.equal(store.getMeta(g).netOkAt, now);
    assert.equal(store.getText(g), TEXT[g]);
  }
  assert.equal(res.sources.visual.count, 3);
  assert.equal(res.sources.starlink.count, 2);
  // Дубли убраны; МКС — из «станций», Хаббл — из группы «hubble», ступень — из «ярких».
  const ids = res.sats.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual([...ids].sort(), [20580, 22220, 25544, 44713, 48274]);
  assert.equal(byId(res.sats, 25544).group, 'stations');
  assert.equal(byId(res.sats, 20580).group, 'hubble');
  assert.equal(byId(res.sats, 22220).group, 'visual');
  assert.equal(byId(res.sats, 44713).group, 'starlink');

  // Повторный запуск через час: всё из кэша, в сеть не ходим.
  const calls2 = [];
  const updates2 = [];
  const res2 = await loadSatellites({
    store,
    now: now + 3600e3,
    fetchImpl: fakeFetch(() => null, calls2),
    onUpdate: (r) => updates2.push(r),
  });
  assert.equal(calls2.length, 0);
  assert.equal(updates2.length, 1);
  assert.equal(res2.sats.length, 5);
  assert.ok(Object.values(res2.sources).every((s) => s.from === 'cache' && s.fetchedAt === now && s.error === null));

  // Через 13 часов кэш устарел: сначала onUpdate с кэшем, затем с новыми данными.
  const updates3 = [];
  const res3 = await loadSatellites({
    store,
    groups: ['stations'],
    now: now + 13 * 3600e3,
    fetchImpl: fakeFetch((url) => (groupOf(url).net ? { body: tle(0) } : null)),
    onUpdate: (r) => updates3.push(r),
  });
  assert.equal(updates3.length, 2);
  assert.equal(updates3[0].sources.stations.from, 'cache');
  assert.equal(updates3[0].sats.length, 2);
  assert.equal(res3.sources.stations.from, 'network');
  assert.equal(res3.sats.length, 1);

  // force через час после загрузки с CelesTrak: CelesTrak просит не чаще раза в 2 ч — в сеть не ходим.
  const calls4 = [];
  const hubbleOk = fakeFetch(() => ({ body: TEXT.hubble }), calls4);
  const res4 = await loadSatellites({ store, groups: ['hubble'], force: true, now: now + 3600e3, fetchImpl: hubbleOk });
  assert.equal(calls4.length, 0);
  assert.equal(res4.sources.hubble.skippedFresh, true);
  assert.equal(res4.sources.hubble.from, 'cache');
  assert.equal(res4.sources.hubble.error, null);
  assert.equal(res4.sources.hubble.fetchedAt, now);
  // force через 2,5 ч: загрузка, хотя по 12-часовому правилу кэш ещё свежий.
  const res5 = await loadSatellites({ store, groups: ['hubble'], force: true, now: now + 2.5 * 3600e3, fetchImpl: hubbleOk });
  assert.equal(calls4.length, 1);
  assert.equal(res5.sources.hubble.from, 'network');
  assert.equal(res5.sources.hubble.skippedFresh, false);
});

test('loadSatellites: CelesTrak fails (network error, 403 text, CORS) → mirror', async () => {
  const store = createMemoryStore();
  const calls = [];
  const res = await loadSatellites({
    store,
    now: T0,
    baseUrl: 'https://example.github.io/sky-scout/index.html',
    groups: ['stations', 'visual', 'hubble', 'starlink'],
    fetchImpl: fakeFetch((url) => {
      const { net, g } = groupOf(url);
      if (net && g === 'stations') return new TypeError('Failed to fetch');
      if (net && g === 'visual') return { status: 403, body: 'GP data has not updated since your last successful download' };
      if (net) return { body: 'Invalid query' }; // 200, но не TLE
      return { body: TEXT[g] };
    }, calls),
  });
  assert.ok(calls.includes('https://example.github.io/sky-scout/data/tle/stations.txt'));
  for (const g of ['stations', 'visual', 'hubble']) {
    assert.equal(res.sources[g].from, 'mirror', g);
    assert.equal(res.sources[g].error, null);
    assert.equal(typeof res.sources[g].networkError, 'string');
    assert.equal(res.sources[g].newestEpochMs, EPOCH);
    assert.equal(res.sources[g].mirrorOutdated, false); // орбитам полсуток
    assert.equal(store.getText(g), TEXT[g]);
    // Отметка об ошибке CelesTrak не стёрта загрузкой копии.
    assert.equal(store.getMeta(g).from, 'mirror', g);
    assert.equal(store.getMeta(g).failedAt, T0, g);
    assert.equal(store.getMeta(g).retryAfterMs, TLE_RETRY_AFTER_MS, g);
    assert.equal(store.getMeta(g).netOkAt, undefined, g);
  }
  // У Starlink копии на сайте нет: данных нет, ошибка записана.
  assert.equal(res.sources.starlink.from, null);
  assert.equal(res.sources.starlink.count, 0);
  assert.match(res.sources.starlink.error, /CelesTrak/);
  assert.equal(calls.filter((u) => u.includes('starlink')).length, 1);
  assert.equal(res.sats.length, 4);
});

test('loadSatellites: both fail → cache kept, error recorded; one group failing does not break others', async () => {
  const store = createMemoryStore({
    stations: { text: TEXT.stations, fetchedAt: T0 - 24 * 3600e3 },
    hubble: { text: TEXT.hubble, fetchedAt: T0 - 24 * 3600e3 },
  });
  const updates = [];
  const res = await loadSatellites({
    store,
    now: T0,
    groups: ['stations', 'hubble', 'visual'],
    fetchImpl: fakeFetch((url) => {
      const { net, g } = groupOf(url);
      if (g === 'visual' && net) return { body: TEXT.visual };
      if (g === 'hubble' && !net) return { body: TEXT.hubble };
      return new TypeError('Failed to fetch');
    }),
    onUpdate: (r) => updates.push(r),
  });
  assert.equal(updates.length, 2);
  assert.equal(updates[0].sats.length, 3);
  assert.equal(res.sources.stations.from, 'cache');
  assert.equal(res.sources.stations.fetchedAt, T0 - 24 * 3600e3);
  assert.match(res.sources.stations.error, /^CelesTrak: .+; копия на сайте: .+/);
  assert.equal(res.sources.stations.count, 2);
  assert.equal(store.getMeta('stations').fetchedAt, T0 - 24 * 3600e3); // кэш не тронут
  assert.equal(res.sources.hubble.from, 'mirror');
  assert.equal(res.sources.visual.from, 'network');
  assert.equal(byId(res.sats, 25544).group, 'stations');
  assert.equal(res.sats.length, 4);

  // Без сети и без кэша — пустой результат с ошибкой, без исключений.
  const empty = await loadSatellites({ store: createMemoryStore(), now: T0, groups: ['hubble'], fetchImpl: fakeFetch(() => new TypeError('offline')) });
  assert.deepEqual(empty.sats, []);
  assert.equal(empty.sources.hubble.from, null);
  assert.ok(empty.sources.hubble.error);
});

test('loadSatellites: after a CelesTrak failure it is not asked again for 30 minutes', async () => {
  const store = createMemoryStore();
  const calls = [];
  const fetchImpl = fakeFetch((url) => (groupOf(url).net ? { status: 403, body: 'Forbidden' } : null), calls);
  const opts = { store, groups: ['starlink', 'hubble'], fetchImpl };
  let res = await loadSatellites({ ...opts, now: T0 });
  assert.equal(calls.filter((u) => u.startsWith('https://celestrak.org/')).length, 2);
  assert.equal(store.getMeta('starlink').failedAt, T0);
  assert.equal(store.getMeta('starlink').retryAfterMs, TLE_RETRY_AFTER_MS);
  assert.equal(res.sources.starlink.from, null);
  assert.equal(res.sources.starlink.newestEpochMs, null);
  assert.equal(res.sources.starlink.oldestEpochMs, null);

  calls.length = 0;
  res = await loadSatellites({ ...opts, now: T0 + 10 * 60000 });
  assert.deepEqual(calls, ['data/tle/hubble.txt']); // только копия на сайте
  assert.ok(res.sources.starlink.error);

  // force паузу не отменяет: CelesTrak не спрашиваем, копию на сайте — пробуем.
  calls.length = 0;
  res = await loadSatellites({ ...opts, now: T0 + 10 * 60000, force: true });
  assert.deepEqual(calls, ['data/tle/hubble.txt']);
  assert.match(res.sources.starlink.error, /недавно был недоступен/);
  assert.equal(res.sources.starlink.skippedFresh, false);

  calls.length = 0;
  const ok = fakeFetch((url) => ({ body: TEXT[groupOf(url).g] }), calls);
  res = await loadSatellites({ ...opts, fetchImpl: ok, now: T0 + 45 * 60000 });
  assert.equal(calls.length, 2);
  assert.equal(res.sources.starlink.from, 'network');
  assert.equal(store.getMeta('starlink').failedAt, undefined); // успешная загрузка сбрасывает отметку
});

test('loadSatellites: mirror older than cache is ignored', async () => {
  const older = TEXT.hubble.replace(/26268\.50000000/, '26260.50000000');
  // Контрольную сумму строки 1 пересчитываем (эпоха изменилась).
  const fixed = older
    .split('\n')
    .map((l) => (l.startsWith('1 ') ? l.slice(0, 68) + checksum(l) : l))
    .join('\n');
  assert.equal(parseTle(fixed).length, 1);
  const store = createMemoryStore({ hubble: { text: TEXT.hubble, fetchedAt: T0 - 20 * 3600e3 } });
  const res = await loadSatellites({
    store,
    now: T0,
    groups: ['hubble'],
    fetchImpl: fakeFetch((url) => (groupOf(url).net ? { status: 500, body: '' } : { body: fixed })),
  });
  assert.equal(res.sources.hubble.from, 'cache');
  assert.ok(res.sources.hubble.error);
  assert.equal(store.getText('hubble'), TEXT.hubble);
  assert.equal(res.sats[0].epochMs, Date.UTC(2026, 8, 25, 12));
});

test('loadSatellites: exported timing constants', () => {
  assert.equal(TLE_MIN_INTERVAL_MS, 2 * 3600e3);
  assert.equal(TLE_MAX_AGE_MS, 12 * 3600e3);
  assert.equal(TLE_MIRROR_MAX_AGE_MS, 2 * 3600e3);
  assert.equal(TLE_MIRROR_MAX_EPOCH_AGE_MS, 7 * 86400e3);
  assert.equal(TLE_RETRY_AFTER_MS, 30 * 60e3);
  assert.equal(TLE_RETRY_AFTER_TIMEOUT_MS, 3 * 60e3);
});

test('loadSatellites: newestEpochMs / oldestEpochMs describe the orbits, not the download', async () => {
  const store = createMemoryStore();
  const visual = tle(0, 1) + retime(tle(4), '26265.25000000'); // ступень — орбита от 22.09 06:00
  const fetchImpl = fakeFetch((url) => {
    const { net, g } = groupOf(url);
    return net && g === 'visual' ? { body: visual } : null;
  });
  const res = await loadSatellites({ store, now: T0, groups: ['visual', 'starlink'], fetchImpl });
  assert.equal(res.sources.visual.fetchedAt, T0);
  assert.equal(res.sources.visual.newestEpochMs, EPOCH);
  assert.equal(res.sources.visual.oldestEpochMs, Date.UTC(2026, 8, 22, 6));
  assert.equal(res.sources.starlink.count, 0);
  assert.equal(res.sources.starlink.newestEpochMs, null);
  assert.equal(res.sources.starlink.oldestEpochMs, null);
  // Из кэша — те же значения; первый onUpdate (кэш) их тоже содержит.
  const updates = [];
  const again = await loadSatellites({
    store,
    now: T0 + 3600e3,
    groups: ['visual'],
    fetchImpl: fakeFetch(() => null),
    onUpdate: (r) => updates.push(r),
  });
  assert.equal(again.sources.visual.from, 'cache');
  assert.equal(updates[0].sources.visual.newestEpochMs, EPOCH);
  assert.equal(again.sources.visual.oldestEpochMs, Date.UTC(2026, 8, 22, 6));
});

test('loadSatellites: force skips groups downloaded from CelesTrak < 2 h ago and honours the backoff', async () => {
  const store = createMemoryStore();
  const calls = [];
  let up = true;
  const fetchImpl = fakeFetch((url) => {
    const { net, g } = groupOf(url);
    if (up) return { body: TEXT[g] };
    return net ? { status: 503, body: 'Service Unavailable' } : null;
  }, calls);
  const opts = { store, groups: ['stations', 'starlink'], fetchImpl, force: true };
  await loadSatellites({ store, groups: ['stations'], fetchImpl, now: T0 });
  assert.equal(calls.length, 1);

  // Через час «Обновить»: станции свежие (скачаны час назад), Starlink ещё не загружался.
  calls.length = 0;
  let res = await loadSatellites({ ...opts, now: T0 + 60 * 60000 });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /GROUP=starlink/);
  assert.equal(res.sources.stations.skippedFresh, true);
  assert.equal(res.sources.stations.from, 'cache');
  assert.equal(res.sources.stations.error, null);
  assert.equal(res.sources.starlink.skippedFresh, false);
  assert.equal(res.sources.starlink.from, 'network');

  // Ещё раз через минуту до 2 ч: обе группы свежие, в сеть не ходим совсем (и в копию тоже).
  calls.length = 0;
  res = await loadSatellites({ ...opts, now: T0 + 119 * 60000 });
  assert.equal(calls.length, 0);
  assert.ok(Object.values(res.sources).every((s) => s.skippedFresh && s.from === 'cache' && s.error === null));
  assert.equal(res.sats.length, 3);

  // Через 3 ч CelesTrak отвечает 503: ошибка запоминается на 30 минут.
  up = false;
  calls.length = 0;
  const tFail = T0 + 181 * 60000;
  res = await loadSatellites({ ...opts, now: tFail });
  assert.equal(calls.filter(isNet).length, 2);
  assert.equal(res.sources.stations.from, 'cache');
  assert.equal(res.sources.stations.skippedFresh, false);
  assert.ok(res.sources.stations.error);
  assert.equal(store.getMeta('starlink').failedAt, tFail);
  assert.equal(store.getMeta('starlink').retryAfterMs, TLE_RETRY_AFTER_MS);

  // Повторное нажатие через 5 минут: CelesTrak на паузе даже при force, копию на сайте пробуем.
  calls.length = 0;
  res = await loadSatellites({ ...opts, now: tFail + 5 * 60000 });
  assert.deepEqual(calls, ['data/tle/stations.txt']);
  assert.match(res.sources.starlink.error, /недавно был недоступен/);

  // Пауза прошла — спрашиваем снова.
  up = true;
  calls.length = 0;
  res = await loadSatellites({ ...opts, now: tFail + TLE_RETRY_AFTER_MS });
  assert.equal(calls.filter(isNet).length, 2);
  assert.equal(res.sources.starlink.from, 'network');

  // Старая meta без поля from ({fetchedAt} прежних версий) считается загрузкой с CelesTrak.
  const legacy = createMemoryStore({ hubble: { text: TEXT.hubble, fetchedAt: T0 - 30 * 60000 } });
  const calls2 = [];
  res = await loadSatellites({ store: legacy, groups: ['hubble'], force: true, now: T0, fetchImpl: fakeFetch(() => ({ body: TEXT.hubble }), calls2) });
  assert.equal(calls2.length, 0);
  assert.equal(res.sources.hubble.skippedFresh, true);
});

test('loadSatellites: backoff is 3 min after a timeout, 30 min after HTTP 403/429/5xx or TypeError online', async () => {
  const cases = [
    ['AbortError', () => new DOMException('The operation was aborted.', 'AbortError'), TLE_RETRY_AFTER_TIMEOUT_MS],
    ['TimeoutError', () => new DOMException('The operation timed out.', 'TimeoutError'), TLE_RETRY_AFTER_TIMEOUT_MS],
    ['403', () => ({ status: 403, body: 'Forbidden' }), TLE_RETRY_AFTER_MS],
    ['429', () => ({ status: 429, body: 'Too Many Requests' }), TLE_RETRY_AFTER_MS],
    ['503', () => ({ status: 503, body: '' }), TLE_RETRY_AFTER_MS],
    ['TypeError', () => new TypeError('Failed to fetch'), TLE_RETRY_AFTER_MS],
  ];
  for (const [name, fail, delay] of cases) {
    const store = createMemoryStore();
    const calls = [];
    const opts = { store, groups: ['starlink'] };
    await withNavigator({ onLine: true }, () => loadSatellites({ ...opts, now: T0, fetchImpl: fakeFetch(fail, calls) }));
    assert.equal(calls.length, 1, name);
    assert.equal(store.getMeta('starlink').failedAt, T0, name);
    assert.equal(store.getMeta('starlink').retryAfterMs, delay, name);
    // За секунду до конца паузы CelesTrak не спрашиваем (и по кнопке «Обновить» тоже).
    const res = await loadSatellites({ ...opts, now: T0 + delay - 1000, force: true, fetchImpl: fakeFetch(fail, calls) });
    assert.equal(calls.length, 1, name);
    assert.match(res.sources.starlink.error, /недавно был недоступен/, name);
    // После паузы — спрашиваем; успешная загрузка снимает отметку.
    const ok = await loadSatellites({ ...opts, now: T0 + delay, fetchImpl: fakeFetch(() => ({ body: TEXT.starlink }), calls) });
    assert.equal(calls.length, 2, name);
    assert.equal(ok.sources.starlink.from, 'network', name);
    assert.equal(store.getMeta('starlink').failedAt, undefined, name);
  }
});

test('loadSatellites: failures while the device is offline are not remembered', async () => {
  const store = createMemoryStore();
  const calls = [];
  const opts = { store, groups: ['stations'] };
  for (const fail of [() => new TypeError('Failed to fetch'), () => new DOMException('aborted', 'AbortError')]) {
    const res = await withNavigator({ onLine: false }, () => loadSatellites({ ...opts, now: T0, fetchImpl: fakeFetch(fail, calls) }));
    assert.equal(res.sources.stations.from, null);
    assert.ok(res.sources.stations.error);
    assert.equal(store.getMeta('stations'), null);
  }
  assert.equal(calls.filter(isNet).length, 2);
  // Сеть появилась через минуту — CelesTrak спрашиваем сразу.
  calls.length = 0;
  const res = await withNavigator({ onLine: true }, () =>
    loadSatellites({ ...opts, now: T0 + 60000, fetchImpl: fakeFetch(() => ({ body: TEXT.stations }), calls) }),
  );
  assert.equal(calls.length, 1);
  assert.equal(res.sources.stations.from, 'network');
});

test('loadSatellites: mirror data keeps the CelesTrak failure mark and goes stale after 2 h', async () => {
  const store = createMemoryStore();
  const calls = [];
  let celestrakUp = false;
  const fetchImpl = fakeFetch((url) => {
    const { net, g } = groupOf(url);
    if (net) return celestrakUp ? { body: TEXT[g] } : { status: 403, body: 'Forbidden' };
    return { body: TEXT[g] };
  }, calls);
  const opts = { store, groups: ['hubble'], fetchImpl };

  let res = await loadSatellites({ ...opts, now: T0 });
  assert.equal(res.sources.hubble.from, 'mirror');
  assert.deepEqual(store.getMeta('hubble'), { fetchedAt: T0, from: 'mirror', failedAt: T0, retryAfterMs: TLE_RETRY_AFTER_MS });

  // «Обновить» через 10 минут: CelesTrak на паузе, копию перечитываем, отметка об ошибке остаётся.
  calls.length = 0;
  const t1 = T0 + 10 * 60000;
  res = await loadSatellites({ ...opts, now: t1, force: true });
  assert.deepEqual(calls, ['data/tle/hubble.txt']);
  assert.equal(res.sources.hubble.skippedFresh, false);
  assert.equal(store.getMeta('hubble').fetchedAt, t1);
  assert.equal(store.getMeta('hubble').failedAt, T0);

  // Через час без force: копия ещё свежая (< 2 ч) — никуда не ходим.
  calls.length = 0;
  res = await loadSatellites({ ...opts, now: T0 + 60 * 60000 });
  assert.equal(calls.length, 0);
  assert.equal(res.sources.hubble.from, 'cache');

  // «Обновить» через час: пауза после ошибки прошла — CelesTrak спрашиваем снова.
  const t2 = T0 + 60 * 60000;
  res = await loadSatellites({ ...opts, now: t2, force: true });
  assert.equal(calls.filter(isNet).length, 1);
  assert.equal(res.sources.hubble.from, 'mirror');
  assert.equal(store.getMeta('hubble').failedAt, t2);

  // Через 2 ч после загрузки копии (а не через 12) — снова CelesTrak, теперь успешно.
  celestrakUp = true;
  calls.length = 0;
  const t3 = t2 + TLE_MIRROR_MAX_AGE_MS + 60000;
  res = await loadSatellites({ ...opts, now: t3 });
  assert.equal(calls.length, 1);
  assert.ok(isNet(calls[0]));
  assert.equal(res.sources.hubble.from, 'network');
  assert.deepEqual(store.getMeta('hubble'), { fetchedAt: t3, from: 'network', netOkAt: t3 });
});

test('loadSatellites: mirror with orbits older than 7 days — rejected if the cache is newer, else accepted and marked', async () => {
  const old = retime(TEXT.hubble, '26260.50000000'); // 17.09.2026 12:00 — на момент T0 8,5 суток
  const older = retime(TEXT.hubble, '26250.50000000'); // 07.09.2026 12:00
  const netDown = (mirrorBody) => fakeFetch((url) => (groupOf(url).net ? { status: 503, body: '' } : { body: mirrorBody }));

  // Кэша нет — принимаем с пометкой; пометка сохраняется и при чтении из кэша.
  let store = createMemoryStore();
  let res = await loadSatellites({ store, now: T0, groups: ['hubble'], fetchImpl: netDown(old) });
  assert.equal(res.sources.hubble.from, 'mirror');
  assert.equal(res.sources.hubble.error, null);
  assert.equal(res.sources.hubble.mirrorOutdated, true);
  assert.equal(res.sources.hubble.newestEpochMs, Date.UTC(2026, 8, 17, 12));
  res = await loadSatellites({ store, now: T0 + 60000, groups: ['hubble'], fetchImpl: netDown(old) });
  assert.equal(res.sources.hubble.from, 'cache');
  assert.equal(res.sources.hubble.mirrorOutdated, true);

  // В кэше ещё более старые орбиты — копию принимаем, с пометкой.
  store = createMemoryStore({ hubble: { text: older, fetchedAt: T0 - 20 * 3600e3 } });
  res = await loadSatellites({ store, now: T0, groups: ['hubble'], fetchImpl: netDown(old) });
  assert.equal(res.sources.hubble.from, 'mirror');
  assert.equal(res.sources.hubble.mirrorOutdated, true);
  assert.equal(store.getText('hubble'), old);

  // В кэше орбиты новее — копию отвергаем, кэш остаётся.
  store = createMemoryStore({ hubble: { text: TEXT.hubble, fetchedAt: T0 - 20 * 3600e3 } });
  res = await loadSatellites({ store, now: T0, groups: ['hubble'], fetchImpl: netDown(old) });
  assert.equal(res.sources.hubble.from, 'cache');
  assert.match(res.sources.hubble.error, /старее/);
  assert.equal(res.sources.hubble.mirrorOutdated, false);
  assert.equal(res.sources.hubble.newestEpochMs, EPOCH);
  assert.equal(store.getText('hubble'), TEXT.hubble);

  // Свежая копия — без пометки; старые орбиты с CelesTrak пометку «копия» не получают.
  res = await loadSatellites({ store: createMemoryStore(), now: T0, groups: ['hubble'], fetchImpl: netDown(TEXT.hubble) });
  assert.equal(res.sources.hubble.mirrorOutdated, false);
  res = await loadSatellites({ store: createMemoryStore(), now: T0, groups: ['hubble'], fetchImpl: fakeFetch(() => ({ body: old })) });
  assert.equal(res.sources.hubble.from, 'network');
  assert.equal(res.sources.hubble.mirrorOutdated, false);
});

test('performance: satPosition µs per call (informational)', (t) => {
  const sats = parseTle(FIXTURE);
  const out = {};
  const N = 20000;
  let date = T0;
  const ctx = frameContext(date);
  for (let i = 0; i < 2000; i++) satPosition(sats[i % 5], date, barcelona, ctx, out); // прогрев
  const t0 = performance.now();
  for (let i = 0; i < N; i++) satPosition(sats[i % 5], date, barcelona, ctx, out);
  const us = ((performance.now() - t0) / N) * 1000;
  t.diagnostic(`satPosition: ${us.toFixed(2)} µs/call`);
  assert.ok(us < 50);
});
