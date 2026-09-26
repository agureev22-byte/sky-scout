#!/usr/bin/env node
// Builds the offline star catalogue and constellation figures used by the sky map:
//   data/stars.json          — every star down to magnitude 6.0 (~5000 stars)
//   data/constellations.json — 88 constellations: Russian names (+ genitive),
//                              label position and stick-figure lines
//
// Sources:
//   - d3-celestial by Olaf Frohn (BSD-3-Clause, https://github.com/ofrohn/d3-celestial),
//     star positions/magnitudes from the Hipparcos catalogue (ESA): stars.6.json,
//     starnames.json, constellations.json, constellations.lines.json
//     (npm package "d3-celestial", directory package/data).
//   - optional: HYG star database v4.1 by David Nash / astronexus
//     (CC BY-SA 4.0, https://github.com/astronexus/HYG-Database), used only to add
//     distances ("dist", parsecs) and, for stars d3-celestial has no designation for, the
//     constellation ("con") and Bayer/Flamsteed designation ("bayer"/"flam"). Rows are matched
//     by HIP; the few stars HYG lists differently (components of multiple stars without a HIP
//     number, or under the companion's HIP) are matched by position (< 0.02°) and
//     magnitude (± 0.75).
//     Download: https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/hygdata_v41.csv
//
// Usage (from the repo root):
//   npm pack d3-celestial && tar xzf d3-celestial-*.tgz      # -> package/data
//   node tools/build-catalog.mjs <d3-celestial data dir> [hygdata_v41.csv] [--out <dir>]
//   e.g. node tools/build-catalog.mjs /tmp/package/data /tmp/hygdata_v41.csv
// Without the HYG csv the "dist" table is omitted (no distances are invented) and "con"
// covers only stars with a d3-celestial constellation.
// Output goes to <repo>/data unless --out is given. Output is deterministic.
//
// data/stars.json (no whitespace):
//   {"v":1,"epoch":"J2000","source":"…","license":"…","fields":["ra","dec","mag","bv","hip"],
//    "stars":[[ra,dec,mag,bv,hip],…],   // mag <= 6.0, sorted by mag ascending (ties by hip);
//                                        // ra in [0,360) deg and dec in deg (3 decimals, J2000),
//                                        // mag 2 decimals, bv (B−V colour index) 2 decimals or null
//    "names":{"<hip>":"Сириус",…},       // Russian proper names (d3-celestial "ru", with fixes below)
//    "bayer":{"<hip>":"α",…},            // Greek Bayer letter (component index as superscript, "α¹"),
//                                        // else Flamsteed number ("61"), else Latin Bayer/Lacaille
//                                        // letter ("a", "G") — for southern stars without the others;
//                                        // HYG fills in stars d3-celestial has no designation for
//    "con":{"<hip>":"CMa",…},            // IAU constellation abbreviation (one of the 88 ids):
//                                        // d3-celestial "c" = constellation of the designation
//                                        // (so bayer+con gives e.g. "α CMa"); stars without it get
//                                        // the boundary-based constellation from HYG
//    "dist":{"<hip>":8.6,…}}             // light years (parsecs × 3.26156), 3 significant digits;
//                                        // only when HYG has a usable parallax distance
//
// data/constellations.json (no whitespace):
//   {"v":1,"source":"…","license":"…","items":[{"id":"And","name":"Андромеда","gen":"Андромеды",
//     "rank":1,"label":[ra,dec],"lines":[[[ra,dec],…],…]},…]}
//   - 88 items in d3-celestial order; name/gen are the standard Russian IAU names from the
//     table below (d3-celestial "ru" is checked against it and differences are reported);
//   - rank 1..3 = importance (1 = most prominent), from d3-celestial;
//   - lines are polylines, ra normalised to [0,360) but NOT split at the 0/360 seam
//     (consumers work on the sphere);
//   - Serpens comes as two features in d3-celestial (Caput and Cauda); they are merged into
//     one item "Ser": lines concatenated, "label" = Serpens Caput, extra "label2" = Serpens Cauda.

import { readFileSync, writeFileSync, mkdirSync, existsSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_MAG = 6.0;
const PC_TO_LY = 3.26156;

// Standard Russian names of the 88 IAU constellations: [nominative, genitive].
const CONSTELLATIONS_RU = {
  And: ['Андромеда', 'Андромеды'],
  Ant: ['Насос', 'Насоса'],
  Aps: ['Райская Птица', 'Райской Птицы'],
  Aqr: ['Водолей', 'Водолея'],
  Aql: ['Орёл', 'Орла'],
  Ara: ['Жертвенник', 'Жертвенника'],
  Ari: ['Овен', 'Овна'],
  Aur: ['Возничий', 'Возничего'],
  Boo: ['Волопас', 'Волопаса'],
  Cae: ['Резец', 'Резца'],
  Cam: ['Жираф', 'Жирафа'],
  Cnc: ['Рак', 'Рака'],
  CVn: ['Гончие Псы', 'Гончих Псов'],
  CMa: ['Большой Пёс', 'Большого Пса'],
  CMi: ['Малый Пёс', 'Малого Пса'],
  Cap: ['Козерог', 'Козерога'],
  Car: ['Киль', 'Киля'],
  Cas: ['Кассиопея', 'Кассиопеи'],
  Cen: ['Центавр', 'Центавра'],
  Cep: ['Цефей', 'Цефея'],
  Cet: ['Кит', 'Кита'],
  Cha: ['Хамелеон', 'Хамелеона'],
  Cir: ['Циркуль', 'Циркуля'],
  Col: ['Голубь', 'Голубя'],
  Com: ['Волосы Вероники', 'Волос Вероники'],
  CrA: ['Южная Корона', 'Южной Короны'],
  CrB: ['Северная Корона', 'Северной Короны'],
  Crv: ['Ворон', 'Ворона'],
  Crt: ['Чаша', 'Чаши'],
  Cru: ['Южный Крест', 'Южного Креста'],
  Cyg: ['Лебедь', 'Лебедя'],
  Del: ['Дельфин', 'Дельфина'],
  Dor: ['Золотая Рыба', 'Золотой Рыбы'],
  Dra: ['Дракон', 'Дракона'],
  Equ: ['Малый Конь', 'Малого Коня'],
  Eri: ['Эридан', 'Эридана'],
  For: ['Печь', 'Печи'],
  Gem: ['Близнецы', 'Близнецов'],
  Gru: ['Журавль', 'Журавля'],
  Her: ['Геркулес', 'Геркулеса'],
  Hor: ['Часы', 'Часов'],
  Hya: ['Гидра', 'Гидры'],
  Hyi: ['Южная Гидра', 'Южной Гидры'],
  Ind: ['Индеец', 'Индейца'],
  Lac: ['Ящерица', 'Ящерицы'],
  Leo: ['Лев', 'Льва'],
  LMi: ['Малый Лев', 'Малого Льва'],
  Lep: ['Заяц', 'Зайца'],
  Lib: ['Весы', 'Весов'],
  Lup: ['Волк', 'Волка'],
  Lyn: ['Рысь', 'Рыси'],
  Lyr: ['Лира', 'Лиры'],
  Men: ['Столовая Гора', 'Столовой Горы'],
  Mic: ['Микроскоп', 'Микроскопа'],
  Mon: ['Единорог', 'Единорога'],
  Mus: ['Муха', 'Мухи'],
  Nor: ['Наугольник', 'Наугольника'],
  Oct: ['Октант', 'Октанта'],
  Oph: ['Змееносец', 'Змееносца'],
  Ori: ['Орион', 'Ориона'],
  Pav: ['Павлин', 'Павлина'],
  Peg: ['Пегас', 'Пегаса'],
  Per: ['Персей', 'Персея'],
  Phe: ['Феникс', 'Феникса'],
  Pic: ['Живописец', 'Живописца'],
  Psc: ['Рыбы', 'Рыб'],
  PsA: ['Южная Рыба', 'Южной Рыбы'],
  Pup: ['Корма', 'Кормы'],
  Pyx: ['Компас', 'Компаса'],
  Ret: ['Сетка', 'Сетки'],
  Sge: ['Стрела', 'Стрелы'],
  Sgr: ['Стрелец', 'Стрельца'],
  Sco: ['Скорпион', 'Скорпиона'],
  Scl: ['Скульптор', 'Скульптора'],
  Sct: ['Щит', 'Щита'],
  Ser: ['Змея', 'Змеи'],
  Sex: ['Секстант', 'Секстанта'],
  Tau: ['Телец', 'Тельца'],
  Tel: ['Телескоп', 'Телескопа'],
  Tri: ['Треугольник', 'Треугольника'],
  TrA: ['Южный Треугольник', 'Южного Треугольника'],
  Tuc: ['Тукан', 'Тукана'],
  UMa: ['Большая Медведица', 'Большой Медведицы'],
  UMi: ['Малая Медведица', 'Малой Медведицы'],
  Vel: ['Паруса', 'Парусов'],
  Vir: ['Дева', 'Девы'],
  Vol: ['Летучая Рыба', 'Летучей Рыбы'],
  Vul: ['Лисичка', 'Лисички'],
};

// Fixes for Russian star names in d3-celestial starnames.json (keyed by HIP).
// A string replaces the name, null drops it (the star is then labelled by its designation).
const STAR_NAME_FIXES = {
  54879: 'Шертан', //           θ Leo (Chertan) was mislabelled "Шератан" (= β Ari)
  74785: 'Зубен Эльшемали', //  β Lib, spelled like α Lib "Зубен Эльгенуби"
  42913: 'Альсефина', //        δ Vel (Alsephina)
  97938: 'Либертас', //         ξ Aql (Libertas), typo "Либерас"
  54682: 'Аль Шарасиф', //      β Crt, typo "Щ"
  47452: 'Аль Шарасиф', //      β Hya, typo "Щ"
  26451: 'Тяньгуань', //        ζ Tau (Tianguan), standard Russian transcription of Chinese
  87261: 'Фуюэ', //             G Sco (Fuyue)
  69732: 'Сюаньгэ', //          λ Boo (Xuange)
  57399: 'Тайяншоу', //         χ UMa (Taiyangshou)
  37265: 'Цзишуй', //           ο Gem (Jishui)
  69427: 'Кан', //              κ Vir (Kang)
  70300: null, //               "Гелиевая переменная звезда Бидельмана" — a description, not a name
  100044: null, //              P Cyg, "Потусторонняя Лебедя" — garbled translation
  62763: null, //               31 Com, "Поларис Галактикус Бореалис" — a description, not a name
  26221: null, //               θ¹ Ori C labelled "Звезда Беклина" — that is a different (infrared) object
};

const GREEK = {
  Alp: 'α', Bet: 'β', Gam: 'γ', Del: 'δ', Eps: 'ε', Zet: 'ζ', Eta: 'η', The: 'θ',
  Iot: 'ι', Kap: 'κ', Lam: 'λ', Mu: 'μ', Nu: 'ν', Xi: 'ξ', Omi: 'ο', Pi: 'π',
  Rho: 'ρ', Sig: 'σ', Tau: 'τ', Ups: 'υ', Phi: 'φ', Chi: 'χ', Psi: 'ψ', Ome: 'ω',
};

const SUPERSCRIPT = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };

// ---------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const positional = [];
  let out = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out = argv[++i];
    else if (argv[i] === '-h' || argv[i] === '--help') return null;
    else positional.push(argv[i]);
  }
  if (positional.length < 1 || positional.length > 2) return null;
  return { dataDir: positional[0], hygCsv: positional[1] ?? null, out };
}

const round = (x, digits) => {
  const f = 10 ** digits;
  const r = Math.round(x * f) / f;
  return Object.is(r, -0) ? 0 : r;
};

/** Longitude-style RA (−180..180 or 0..360) → [0,360), rounded to 3 decimals. */
function normRa(lon) {
  let ra = round(((lon % 360) + 360) % 360, 3);
  if (ra >= 360) ra = 0;
  return ra;
}

const point = ([lon, lat]) => [normRa(lon), round(lat, 3)];

const cleanText = (s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');

const toSuperscript = (digits) => digits.replace(/\d/g, (d) => SUPERSCRIPT[d]);

/** Short designation: Greek Bayer letter, else Flamsteed number, else Latin Bayer letter. */
function designation(entry) {
  const bayer = cleanText(entry.bayer);
  const flam = cleanText(entry.flam);
  const greek = /^([α-ω])(\d?)$/.exec(bayer);
  if (greek) return greek[1] + toSuperscript(greek[2]);
  if (/^\d+$/.test(flam)) return flam;
  const latin = /^([A-Za-z])(\d?)$/.exec(bayer);
  if (latin) return latin[1] + toSuperscript(latin[2]);
  return null;
}

/** Minimal RFC 4180 line splitter (quoted fields, doubled quotes). */
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Designation from HYG columns: bayer "Kap-1" → "κ¹", else Flamsteed number. */
function hygDesignation(bayerCol, flamCol) {
  const m = /^([A-Z][a-z]{1,2})(?:-(\d))?$/.exec(cleanText(bayerCol));
  if (m && GREEK[m[1]]) return GREEK[m[1]] + toSuperscript(m[2] ?? '');
  const flam = cleanText(flamCol);
  return /^\d+$/.test(flam) ? flam : null;
}

/** Angular separation in degrees (small angles, fine for matching). */
function sepDeg(ra1, dec1, ra2, dec2) {
  const dra = ((((ra1 - ra2) % 360) + 540) % 360) - 180;
  const x = dra * Math.cos(((dec1 + dec2) / 2) * (Math.PI / 180));
  return Math.hypot(x, dec1 - dec2);
}

/**
 * Reads a HYG csv for the wanted stars (Map hip → [ra, dec, mag]).
 * Returns Map(hip → {pc, con, des}); pc = distance in parsecs or null when unknown,
 * con = constellation abbreviation or null, des = designation or null.
 */
async function readHyg(csvPath, wanted) {
  const rl = createInterface({ input: createReadStream(csvPath, 'utf8'), crlfDelay: Infinity });
  let col = null;
  const byHip = new Map();
  const others = []; // bright HYG rows not matched by HIP (e.g. components of multiple stars)
  for await (const line of rl) {
    if (!col) {
      const header = splitCsvLine(line);
      col = Object.fromEntries(['hip', 'ra', 'dec', 'mag', 'dist', 'con', 'bayer', 'flam'].map((k) => [k, header.indexOf(k)]));
      const missing = Object.keys(col).filter((k) => col[k] < 0);
      if (missing.length) throw new Error(`${csvPath}: no columns ${missing.join(', ')}`);
      continue;
    }
    if (!line) continue;
    const cols = splitCsvLine(line);
    const hip = cols[col.hip] === '' ? 0 : Number(cols[col.hip]);
    const mag = Number(cols[col.mag]);
    const known = Number.isInteger(hip) && hip > 0 && wanted.has(hip);
    if (!known && !(mag <= MAX_MAG + 1.5)) continue;
    const pcRaw = Number(cols[col.dist]);
    const c = cleanText(cols[col.con]);
    const row = {
      // HYG uses dist >= 100000 for missing/negative parallaxes.
      pc: Number.isFinite(pcRaw) && pcRaw > 0 && pcRaw < 100000 ? pcRaw : null,
      con: CONSTELLATIONS_RU[c] ? c : null,
      des: hygDesignation(cols[col.bayer], cols[col.flam]),
    };
    if (known) byHip.set(hip, row);
    else others.push({ ...row, ra: Number(cols[col.ra]) * 15, dec: Number(cols[col.dec]), mag });
  }
  for (const [hip, [ra, dec, mag]] of wanted) {
    if (byHip.has(hip)) continue;
    let best = null;
    let bestSep = 0.02;
    for (const r of others) {
      if (Math.abs(r.dec - dec) > 0.02 || Math.abs(r.mag - mag) > 0.75) continue;
      const d = sepDeg(ra, dec, r.ra, r.dec);
      if (d < bestSep) { best = r; bestSep = d; }
    }
    if (best) byHip.set(hip, { pc: best.pc, con: best.con, des: best.des });
  }
  return byHip;
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error('Usage: node tools/build-catalog.mjs <d3-celestial data dir> [hygdata_v41.csv] [--out <dir>]');
    process.exit(2);
  }
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dataDir = path.resolve(args.dataDir);
  const outDir = args.out ? path.resolve(args.out) : path.join(repoRoot, 'data');

  const starsGeo = readJson(path.join(dataDir, 'stars.6.json'));
  const starNames = readJson(path.join(dataDir, 'starnames.json'));
  const consGeo = readJson(path.join(dataDir, 'constellations.json'));
  const linesGeo = readJson(path.join(dataDir, 'constellations.lines.json'));

  const licenseFile = path.join(dataDir, '..', 'LICENSE');
  const bsdLicense = existsSync(licenseFile)
    ? readFileSync(licenseFile, 'utf8').replace(/\r/g, '').trim()
    : 'Copyright (c) 2015, Olaf Frohn. All rights reserved. BSD-3-Clause.';

  // ---- stars ----
  const stars = [];
  for (const f of starsGeo.features) {
    const hip = Number(f.id);
    const mag = Number(f.properties.mag);
    if (!Number.isInteger(hip) || hip <= 0) throw new Error(`bad HIP id ${f.id}`);
    if (!Number.isFinite(mag) || mag > MAX_MAG) continue;
    const [lon, lat] = f.geometry.coordinates;
    const bvRaw = f.properties.bv;
    const bv = bvRaw === '' || bvRaw == null || !Number.isFinite(Number(bvRaw)) ? null : round(Number(bvRaw), 2);
    stars.push([normRa(lon), round(lat, 3), round(mag, 2), bv, hip]);
  }
  stars.sort((a, b) => a[2] - b[2] || a[4] - b[4]);
  const present = new Set(stars.map((s) => s[4]));
  if (present.size !== stars.length) throw new Error('duplicate HIP numbers in stars.6.json');

  const names = {};
  const bayer = {};
  const con = {};
  const nameFixesUsed = new Set();
  for (const [, , , , hip] of stars) {
    const entry = starNames[hip];
    if (!entry) continue;
    let ru = cleanText(entry.ru);
    if (Object.prototype.hasOwnProperty.call(STAR_NAME_FIXES, hip)) {
      nameFixesUsed.add(hip);
      ru = STAR_NAME_FIXES[hip] ?? '';
    }
    if (ru) names[hip] = ru;
    const des = designation(entry);
    if (des) bayer[hip] = des;
    const c = cleanText(entry.c);
    if (c && CONSTELLATIONS_RU[c]) con[hip] = c;
  }
  for (const hip of Object.keys(STAR_NAME_FIXES)) {
    if (!nameFixesUsed.has(Number(hip))) console.warn(`warning: name fix for HIP ${hip} not used`);
  }

  let dist = null;
  let conFromHyg = 0;
  let desFromHyg = 0;
  if (args.hygCsv) {
    const wanted = new Map(stars.map(([ra, dec, mag, , hip]) => [hip, [ra, dec, mag]]));
    const hyg = await readHyg(path.resolve(args.hygCsv), wanted);
    dist = {};
    for (const [, , , , hip] of stars) {
      const h = hyg.get(hip);
      if (!h) continue;
      if (h.pc !== null) dist[hip] = Number((h.pc * PC_TO_LY).toPrecision(3));
      if (!bayer[hip] && h.des) {
        bayer[hip] = h.des;
        desFromHyg++;
        if (h.con) con[hip] = h.con; // keep designation and its constellation consistent
      }
      if (!con[hip] && h.con) {
        con[hip] = h.con;
        conFromHyg++;
      }
    }
    console.log(`HYG: ${hyg.size} of ${stars.length} stars matched`);
  }

  const starsSource =
    'Звёзды, имена и обозначения: d3-celestial © 2015 Olaf Frohn, лицензия BSD-3-Clause ' +
    '(https://github.com/ofrohn/d3-celestial), по данным каталога Hipparcos (ESA); ' +
    'названия звёзд частично исправлены.' +
    (dist
      ? ' Расстояния, часть созвездий и обозначений: база HYG v4.1 © David Nash (astronexus), лицензия CC BY-SA 4.0 ' +
        '(https://github.com/astronexus/HYG-Database).'
      : '');

  const starsOut = {
    v: 1,
    epoch: 'J2000',
    source: starsSource,
    license: bsdLicense,
    fields: ['ra', 'dec', 'mag', 'bv', 'hip'],
    stars,
    names,
    bayer,
    con,
  };
  if (dist) starsOut.dist = dist;

  // ---- constellations ----
  const linesById = new Map();
  for (const f of linesGeo.features) {
    if (f.geometry.type !== 'MultiLineString') throw new Error(`${f.id}: unexpected ${f.geometry.type}`);
    const list = linesById.get(f.id) ?? [];
    for (const line of f.geometry.coordinates) list.push(line.map(point));
    linesById.set(f.id, list);
  }
  const items = [];
  const byId = new Map();
  for (const f of consGeo.features) {
    const id = f.id;
    const ru = CONSTELLATIONS_RU[id];
    if (!ru) throw new Error(`unknown constellation id ${id}`);
    const label = point(f.geometry.coordinates);
    const existing = byId.get(id);
    if (existing) {
      // Serpens Cauda: second feature for the same constellation.
      existing.label2 = label;
      continue;
    }
    const dataRu = cleanText(f.properties.ru);
    if (dataRu.replace(/ё/g, 'е') !== ru[0].replace(/ё/g, 'е')) {
      console.warn(`note: ${id} d3-celestial "${dataRu}" -> "${ru[0]}"`);
    }
    const lines = linesById.get(id);
    if (!lines || lines.length === 0) throw new Error(`${id}: no lines`);
    const item = { id, name: ru[0], gen: ru[1], rank: parseInt(f.properties.rank, 10), label, lines };
    byId.set(id, item);
    items.push(item);
  }
  const missing = Object.keys(CONSTELLATIONS_RU).filter((id) => !byId.has(id));
  if (missing.length || items.length !== 88) throw new Error(`expected 88 constellations, missing: ${missing}`);

  const consOut = {
    v: 1,
    source:
      'Фигуры созвездий и положения подписей: d3-celestial © 2015 Olaf Frohn, лицензия BSD-3-Clause ' +
      '(https://github.com/ofrohn/d3-celestial); русские названия созвездий по списку МАС.',
    license: bsdLicense,
    items,
  };

  mkdirSync(outDir, { recursive: true });
  const starsFile = path.join(outDir, 'stars.json');
  const consFile = path.join(outDir, 'constellations.json');
  writeFileSync(starsFile, JSON.stringify(starsOut));
  writeFileSync(consFile, JSON.stringify(consOut));

  const kb = (file) => (readFileSync(file).length / 1024).toFixed(1);
  console.log(
    `${starsFile}: ${stars.length} stars (mag ${stars[0][2]}..${stars[stars.length - 1][2]}), ` +
      `${Object.keys(names).length} Russian names, ` +
      `${Object.keys(bayer).length} designations (${desFromHyg} from HYG), ` +
      `${Object.keys(con).length} with constellation (${conFromHyg} from HYG), ` +
      `${dist ? Object.keys(dist).length : 0} distances; ${kb(starsFile)} KiB`,
  );
  console.log(
    `${consFile}: ${items.length} constellations, ` +
      `${items.reduce((n, c) => n + c.lines.length, 0)} polylines; ${kb(consFile)} KiB`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
