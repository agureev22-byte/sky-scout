// Checks the offline star catalogue and constellation figures built by tools/build-catalog.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const load = (name) => JSON.parse(readFileSync(new URL(`../data/${name}`, import.meta.url), 'utf8'));
const stars = load('stars.json');
const cons = load('constellations.json');

const byHip = new Map(stars.stars.map((s) => [s[4], s]));
const consById = new Map(cons.items.map((c) => [c.id, c]));
const CYRILLIC = /^[А-ЯЁ][а-яё]+(?:[ -][А-ЯЁа-яё][а-яё]+)*$/;

/** Great-circle distance in degrees. */
function sep([ra1, dec1], [ra2, dec2]) {
  const r = Math.PI / 180;
  const c =
    Math.sin(dec1 * r) * Math.sin(dec2 * r) +
    Math.cos(dec1 * r) * Math.cos(dec2 * r) * Math.cos((ra1 - ra2) * r);
  return Math.acos(Math.min(1, Math.max(-1, c))) / r;
}

const close = (actual, expected, tol, what) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${what}: ${actual} is not within ${tol} of ${expected}`);

test('stars.json: header and row format', () => {
  assert.equal(stars.v, 1);
  assert.equal(stars.epoch, 'J2000');
  assert.deepEqual(stars.fields, ['ra', 'dec', 'mag', 'bv', 'hip']);
  assert.match(stars.source, /d3-celestial/);
  assert.match(stars.source, /BSD-3-Clause/);
  assert.match(stars.source, /Hipparcos/);
  if (stars.dist) assert.match(stars.source, /HYG.*CC BY-SA/);
  assert.ok(stars.stars.length >= 4900 && stars.stars.length <= 5200, `count ${stars.stars.length}`);
  for (const row of stars.stars) {
    assert.equal(row.length, 5);
    const [ra, dec, mag, bv, hip] = row;
    assert.ok(ra >= 0 && ra < 360, `ra ${ra}`);
    assert.ok(dec >= -90 && dec <= 90, `dec ${dec}`);
    assert.ok(Number.isFinite(mag) && mag <= 6.0, `mag ${mag}`);
    assert.ok(bv === null || (Number.isFinite(bv) && bv > -1 && bv < 3.5), `bv ${bv}`);
    assert.ok(Number.isInteger(hip) && hip > 0, `hip ${hip}`);
    // rounding: at most 3 decimals for coordinates, 2 for mag/bv
    assert.equal(ra, Math.round(ra * 1000) / 1000);
    assert.equal(mag, Math.round(mag * 100) / 100);
  }
  assert.equal(byHip.size, stars.stars.length, 'HIP numbers are unique');
});

test('stars.json: sorted by magnitude, brightest first', () => {
  for (let i = 1; i < stars.stars.length; i++) {
    assert.ok(stars.stars[i - 1][2] <= stars.stars[i][2], `row ${i} out of order`);
  }
  assert.equal(stars.stars[0][4], 32349, 'Sirius comes first');
  assert.ok(stars.stars.filter((s) => s[2] < 1.5).length >= 20, 'first-magnitude stars present');
});

test('stars.json: well-known stars', () => {
  const sirius = byHip.get(32349);
  close(sirius[0], 101.287, 0.01, 'Sirius ra');
  close(sirius[1], -16.716, 0.01, 'Sirius dec');
  close(sirius[2], -1.46, 0.05, 'Sirius mag');
  assert.equal(stars.names['32349'], 'Сириус');
  assert.equal(stars.bayer['32349'], 'α');
  assert.equal(stars.con['32349'], 'CMa');

  const vega = byHip.get(91262);
  close(vega[0], 279.235, 0.01, 'Vega ra');
  close(vega[1], 38.784, 0.01, 'Vega dec');
  assert.equal(stars.names['91262'], 'Вега');
  assert.equal(stars.con['91262'], 'Lyr');

  const polaris = byHip.get(11767);
  assert.ok(polaris, 'Polaris is in the catalogue');
  assert.ok(polaris[1] > 89, 'Polaris is near the pole');
  assert.match(stars.names['11767'], /^Полярная/);
  assert.equal(stars.con['11767'], 'UMi');

  assert.equal(stars.names['27989'], 'Бетельгейзе');
  assert.equal(stars.names['24436'], 'Ригель');
  assert.equal(stars.names['54061'], 'Дубхе');
  assert.equal(stars.bayer['71683'], 'α¹', 'component index as superscript');
  assert.equal(stars.names['54879'], 'Шертан', 'θ Leo is not "Шератан"');
});

test('stars.json: names / bayer / con / dist refer to catalogue stars', () => {
  const keysOk = (table, what) => {
    for (const hip of Object.keys(table)) assert.ok(byHip.has(Number(hip)), `${what}: HIP ${hip} not in stars`);
  };
  keysOk(stars.names, 'names');
  keysOk(stars.bayer, 'bayer');
  keysOk(stars.con, 'con');
  if (stars.dist) keysOk(stars.dist, 'dist');

  const nameCount = Object.keys(stars.names).length;
  assert.ok(nameCount >= 400, `only ${nameCount} names`);
  for (const [hip, name] of Object.entries(stars.names)) {
    assert.equal(name, name.trim(), `HIP ${hip} name has surrounding spaces`);
    assert.ok(name.length > 0 && !/\s{2}/.test(name), `HIP ${hip} name "${name}"`);
    assert.match(name, /^[А-ЯЁ]/, `HIP ${hip} name "${name}" is not Russian`);
  }
  for (const [hip, des] of Object.entries(stars.bayer)) {
    assert.match(des, /^(?:[α-ω][¹²³⁴⁵⁶⁷⁸⁹⁰]*|\d+|[A-Za-z][¹²³⁴⁵⁶⁷⁸⁹⁰]*)$/, `HIP ${hip} designation "${des}"`);
  }
  for (const [hip, c] of Object.entries(stars.con)) {
    assert.ok(consById.has(c), `HIP ${hip} constellation "${c}"`);
  }
  // all named stars have a constellation
  for (const hip of Object.keys(stars.names)) assert.ok(stars.con[hip], `named HIP ${hip} has no constellation`);
});

test('stars.json: distances (light years) are plausible', { skip: !stars.dist && 'no distances in catalogue' }, () => {
  const d = stars.dist;
  close(d['32349'], 8.6, 0.2, 'Sirius distance');
  close(d['91262'], 25, 1, 'Vega distance');
  close(d['37279'], 11.5, 0.3, 'Procyon distance');
  close(d['71683'], 4.4, 0.2, 'Alpha Centauri distance');
  const values = Object.values(d);
  assert.ok(values.length >= 4500, `only ${values.length} distances`);
  for (const [hip, ly] of Object.entries(d)) {
    assert.ok(Number.isFinite(ly) && ly > 4 && ly < 20000, `HIP ${hip}: ${ly} ly`);
    assert.equal(ly, Number(ly.toPrecision(3)), `HIP ${hip}: ${ly} has more than 3 significant digits`);
  }
});

test('constellations.json: 88 constellations with Russian names and figures', () => {
  assert.equal(cons.v, 1);
  assert.match(cons.source, /d3-celestial/);
  assert.equal(cons.items.length, 88);
  assert.equal(consById.size, 88, 'ids are unique');
  for (const c of cons.items) {
    assert.match(c.id, /^[A-Z][A-Za-z]{2}$/);
    assert.match(c.name, CYRILLIC, `${c.id} name "${c.name}"`);
    assert.match(c.gen, CYRILLIC, `${c.id} gen "${c.gen}"`);
    assert.ok([1, 2, 3].includes(c.rank), `${c.id} rank ${c.rank}`);
    const [lra, ldec] = c.label;
    assert.ok(lra >= 0 && lra < 360 && ldec >= -90 && ldec <= 90, `${c.id} label ${c.label}`);
    assert.ok(Array.isArray(c.lines) && c.lines.length >= 1, `${c.id} has no lines`);
    for (const line of c.lines) {
      assert.ok(line.length >= 2, `${c.id}: polyline with ${line.length} points`);
      for (const [ra, dec] of line) {
        assert.ok(ra >= 0 && ra < 360, `${c.id} ra ${ra}`);
        assert.ok(dec >= -90 && dec <= 90, `${c.id} dec ${dec}`);
      }
      // polylines are not split at the 0/360 seam: consecutive points stay close on the sphere
      for (let i = 1; i < line.length; i++) {
        assert.ok(sep(line[i - 1], line[i]) < 40, `${c.id}: segment ${i} is too long`);
      }
    }
  }
});

test('constellations.json: names and genitives', () => {
  const expect = {
    UMa: ['Большая Медведица', 'Большой Медведицы'],
    UMi: ['Малая Медведица', 'Малой Медведицы'],
    CMa: ['Большой Пёс', 'Большого Пса'],
    Com: ['Волосы Вероники', 'Волос Вероники'],
    PsA: ['Южная Рыба', 'Южной Рыбы'],
    Aps: ['Райская Птица', 'Райской Птицы'],
    Ser: ['Змея', 'Змеи'],
    Leo: ['Лев', 'Льва'],
    Ari: ['Овен', 'Овна'],
    Psc: ['Рыбы', 'Рыб'],
    Vel: ['Паруса', 'Парусов'],
    Hor: ['Часы', 'Часов'],
    Tau: ['Телец', 'Тельца'],
    Sgr: ['Стрелец', 'Стрельца'],
    Aql: ['Орёл', 'Орла'],
    Cyg: ['Лебедь', 'Лебедя'],
  };
  for (const [id, [name, gen]] of Object.entries(expect)) {
    assert.equal(consById.get(id).name, name, id);
    assert.equal(consById.get(id).gen, gen, id);
  }
  const names = new Set(cons.items.map((c) => c.name));
  assert.equal(names.size, 88, 'names are unique');
  const gens = new Set(cons.items.map((c) => c.gen));
  assert.equal(gens.size, 88, 'genitives are unique');
});

test('constellations.json: label positions and figures match the sky', () => {
  const ori = consById.get('Ori');
  assert.ok(sep(ori.label, [83, 5]) < 10, `Orion label ${ori.label}`);
  const uma = consById.get('UMa');
  assert.ok(sep(uma.label, [165, 55]) < 20, `Ursa Major label ${uma.label}`);
  const cru = consById.get('Cru');
  assert.ok(cru.label[1] < -50, 'Crux is far south');

  // Almost every figure vertex is a catalogue star (Mira, a variable fainter than 6 mag in
  // Hipparcos, is the known exception).
  let total = 0;
  let matched = 0;
  const nearStar = ([ra, dec]) =>
    stars.stars.some((s) => Math.abs(s[1] - dec) < 0.02 && sep([s[0], s[1]], [ra, dec]) < 0.02);
  for (const c of cons.items) {
    for (const line of c.lines) {
      for (const p of line) {
        total++;
        if (nearStar(p)) matched++;
      }
    }
  }
  assert.ok(matched / total > 0.99, `${matched}/${total} vertices are catalogue stars`);

  // Orion's belt: Alnitak, Alnilam, Mintaka are vertices of the Orion figure.
  const oriPoints = ori.lines.flat();
  for (const hip of [26727, 26311, 25930]) {
    const s = byHip.get(hip);
    assert.ok(oriPoints.some((p) => sep(p, [s[0], s[1]]) < 0.02), `HIP ${hip} not in Orion figure`);
  }
  // figures crossing ra = 0 keep their points in order (some near 360, some near 0)
  const andPoints = consById.get('And').lines.flat();
  assert.ok(andPoints.some((p) => p[0] > 350) && andPoints.some((p) => p[0] < 10), 'Andromeda spans ra 0');
});
