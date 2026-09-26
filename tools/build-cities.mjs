#!/usr/bin/env node
// Builds data/cities.json — the compact city list used by js/lightpollution.js
// to estimate light pollution (sky brightness) offline from proximity to cities.
//
// Source: npm package all-the-cities@3.1.0 (MIT), which packs GeoNames data
// (CC BY 4.0, https://www.geonames.org/).
//
// Usage (from the repo root):
//   npm i --no-save all-the-cities@3.1.0 && node tools/build-cities.mjs
//   node tools/build-cities.mjs /path/to/all-the-cities   # package dir given explicitly
//
// Selection:
//   - population >= 5000;
//   - feature codes PPLX (city sections — would double count the parent city),
//     PPLH (historical), PPLQ (abandoned), PPLW (destroyed), PPLCH (historical
//     capital) are dropped;
//   - sorted by population descending (ties by GeoNames id for a stable output).
//
// Output format (no whitespace):
//   {"v":1,"source":"...","minPopulation":5000,"count":N,"namedCount":K,
//    "d":[lat100,lon100,popThousands, ...],"names":["Tokyo", ...]}
//   lat100/lon100 = round(deg*100), popThousands = max(1, round(pop/1000)).
//   names[] covers the first K entries — every city with population >= 30000
//   (they come first thanks to the sort); smaller towns stay anonymous to keep
//   the file small.

import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIN_POPULATION = 5000;
const NAMED_MIN_POPULATION = 30000;
const DROP_FEATURE_CODES = new Set(['PPLX', 'PPLH', 'PPLQ', 'PPLW', 'PPLCH']);
const EXPECTED_VERSION = '3.1.0';
const SOURCE = 'GeoNames (CC BY 4.0), через npm-пакет all-the-cities';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = process.argv[2]
  ? path.resolve(process.cwd(), process.argv[2])
  : path.join(repoRoot, 'node_modules', 'all-the-cities');
const outFile = path.join(repoRoot, 'data', 'cities.json');

let pkgJson;
try {
  pkgJson = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
} catch (err) {
  console.error(`Не найден пакет all-the-cities в ${pkgDir}`);
  console.error('Установите его: npm i --no-save all-the-cities@3.1.0');
  process.exit(1);
}
if (pkgJson.version !== EXPECTED_VERSION) {
  console.warn(`Внимание: версия all-the-cities ${pkgJson.version}, ожидалась ${EXPECTED_VERSION} — результат может отличаться.`);
}

const require = createRequire(import.meta.url);
const all = require(pkgDir);

const selected = all
  .filter((c) => c.population >= MIN_POPULATION && !DROP_FEATURE_CODES.has(c.featureCode))
  .sort((a, b) => b.population - a.population || Number(a.cityId) - Number(b.cityId));

const d = new Array(selected.length * 3);
const names = [];
selected.forEach((c, i) => {
  const [lon, lat] = c.loc.coordinates;
  d[i * 3] = Math.round(lat * 100);
  d[i * 3 + 1] = Math.round(lon * 100);
  d[i * 3 + 2] = Math.max(1, Math.round(c.population / 1000));
  if (c.population >= NAMED_MIN_POPULATION) {
    if (names.length !== i) throw new Error('Города с именами должны идти первыми');
    names.push(c.name);
  }
});

const out = {
  v: 1,
  source: SOURCE,
  minPopulation: MIN_POPULATION,
  count: selected.length,
  namedCount: names.length,
  d,
  names,
};

const text = JSON.stringify(out);
mkdirSync(path.dirname(outFile), { recursive: true });
writeFileSync(outFile, text);
console.log(
  `${path.relative(process.cwd(), outFile)}: ${out.count} городов, ${out.namedCount} с именами, ` +
  `${(Buffer.byteLength(text) / 1024).toFixed(0)} КБ`,
);
