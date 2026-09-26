// Что на небе: звёзды и созвездия из каталога, Солнце, Луна и планеты (astronomy-engine).

import * as A from '../../vendor/astronomy.js';
import { refractInto } from './view.js';

export const BODIES = [
  { id: 'sun', body: A.Body.Sun, name: 'Солнце', kind: 'sun', color: '#ffd76a' },
  { id: 'moon', body: A.Body.Moon, name: 'Луна', kind: 'moon', color: '#f1eee4' },
  { id: 'mercury', body: A.Body.Mercury, name: 'Меркурий', kind: 'planet', color: '#d8c7ae' },
  { id: 'venus', body: A.Body.Venus, name: 'Венера', kind: 'planet', color: '#fff6dc' },
  { id: 'mars', body: A.Body.Mars, name: 'Марс', kind: 'planet', color: '#ff9f70' },
  { id: 'jupiter', body: A.Body.Jupiter, name: 'Юпитер', kind: 'planet', color: '#ffe3bd' },
  { id: 'saturn', body: A.Body.Saturn, name: 'Сатурн', kind: 'planet', color: '#f5dd9e' },
  { id: 'uranus', body: A.Body.Uranus, name: 'Уран', kind: 'planet', color: '#b9f2ff' },
  { id: 'neptune', body: A.Body.Neptune, name: 'Нептун', kind: 'planet', color: '#93b6ff' },
];

const KM_PER_AU = 149597870.7;
const DEG = Math.PI / 180;

// ---------- каталог ----------

let catalogPromise = null;

export function loadCatalog(base = new URL('../../data/', import.meta.url)) {
  if (!catalogPromise) {
    catalogPromise = Promise.all([
      fetch(new URL('stars.json', base)).then((r) => {
        if (!r.ok) throw new Error(`stars.json: ${r.status}`);
        return r.json();
      }),
      fetch(new URL('constellations.json', base)).then((r) => {
        if (!r.ok) throw new Error(`constellations.json: ${r.status}`);
        return r.json();
      }),
    ]).then(([stars, cons]) => prepareCatalog(stars, cons));
    catalogPromise.catch(() => {
      catalogPromise = null;
    });
  }
  return catalogPromise;
}

function eqjVector(raDeg, decDeg) {
  const ra = raDeg * DEG;
  const dec = decDeg * DEG;
  const c = Math.cos(dec);
  return [c * Math.cos(ra), c * Math.sin(ra), Math.sin(dec)];
}

// Цвет звезды по показателю цвета B−V: 0 — голубая … 5 — красноватая.
function colorClass(bv) {
  if (bv === null || bv === undefined) return 1;
  if (bv < -0.05) return 0;
  if (bv < 0.3) return 1;
  if (bv < 0.6) return 2;
  if (bv < 1.0) return 3;
  if (bv < 1.4) return 4;
  return 5;
}

export function prepareCatalog(starsJson, consJson) {
  const list = starsJson.stars;
  const n = list.length;
  const vec = new Float32Array(3 * n);
  const mag = new Float32Array(n);
  const ra = new Float32Array(n);
  const dec = new Float32Array(n);
  const hip = new Int32Array(n);
  const color = new Uint8Array(n);
  const byHip = new Map();
  for (let i = 0; i < n; i++) {
    const [r, d, m, bv, h] = list[i];
    const v = eqjVector(r, d);
    vec[3 * i] = v[0];
    vec[3 * i + 1] = v[1];
    vec[3 * i + 2] = v[2];
    mag[i] = m;
    ra[i] = r;
    dec[i] = d;
    hip[i] = h;
    color[i] = colorClass(bv);
    byHip.set(h, i);
  }
  const names = starsJson.names || {};
  const bayer = starsJson.bayer || {};
  const con = starsJson.con || {};
  const dist = starsJson.dist || {};
  const constellations = (consJson.items || []).map((c) => ({
    id: c.id,
    name: c.name,
    gen: c.gen,
    rank: Number(c.rank) || 3,
    label: eqjVector(c.label[0], c.label[1]),
    labelEnu: new Float32Array(3),
    lines: c.lines.map((line) => {
      const arr = new Float32Array(line.length * 3);
      line.forEach(([r, d], k) => {
        const v = eqjVector(r, d);
        arr[3 * k] = v[0];
        arr[3 * k + 1] = v[1];
        arr[3 * k + 2] = v[2];
      });
      return arr;
    }),
  }));
  // Для каждой линии — массив под мировые координаты (пересчитываются каждый кадр без новых объектов).
  for (const c of constellations) c.linesEnu = c.lines.map((a) => new Float32Array(a.length));
  const conById = new Map(constellations.map((c) => [c.id, c]));
  // Именованные звёзды — для подписей и поиска.
  const named = [];
  for (let i = 0; i < n; i++) {
    const name = names[hip[i]];
    if (name) named.push(i);
  }
  return {
    count: n,
    vec,
    mag,
    ra,
    dec,
    hip,
    color,
    byHip,
    names,
    bayer,
    con,
    dist,
    named,
    constellations,
    conById,
    source: starsJson.source,
  };
}

export function starName(cat, i) {
  return cat.names[cat.hip[i]] || null;
}

// «α Лиры» или «61 Лебедя», если есть обозначение.
export function starDesignation(cat, i) {
  const h = cat.hip[i];
  const b = cat.bayer[h];
  const c = cat.con[h];
  const cons = c && cat.conById.get(c);
  if (b && cons && cons.gen) return `${b} ${cons.gen}`;
  return null;
}

// ---------- небо в момент времени ----------

export class Sky {
  constructor() {
    this.observer = new A.Observer(0, 0, 0);
    this.lat = 0;
    this.lon = 0;
    this.time = null;
    this.M = null; // J2000 экваториальные → мир (восток, север, вверх)
    this.bodies = BODIES.map((b) => ({ ...b, alt: -90, az: 0, vec: [0, 0, -1], distAU: 1 }));
    this.bodiesAt = 0;
    this.starEnu = null;
    this.starsAt = 0;
  }

  setObserver(lat, lon, elevation = 0) {
    this.observer = new A.Observer(lat, lon, Number.isFinite(elevation) ? elevation : 0);
    this.lat = lat;
    this.lon = lon;
    this.bodiesAt = 0;
    this.starsAt = 0;
  }

  // Пересчёт матрицы поворота неба и (не чаще раза в 0,5 с по времени неба) — тел.
  update(ms, force = false) {
    const t = A.MakeTime(new Date(ms));
    const m = A.Rotation_EQJ_HOR(t, this.observer).rot;
    // В системе горизонта astronomy-engine: x — север, y — запад, z — зенит.
    this.M = [
      [-m[0][1], -m[1][1], -m[2][1]],
      [m[0][0], m[1][0], m[2][0]],
      [m[0][2], m[1][2], m[2][2]],
    ];
    this.time = ms;
    if (force || Math.abs(ms - this.bodiesAt) > 500) this.updateBodies(ms);
  }

  eqjToEnu(v) {
    const M = this.M;
    return [
      M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2],
      M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2],
      M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2],
    ];
  }

  // J2000 → мир с рефракцией для массива векторов (массив out переиспользуется).
  transformArray(v, out) {
    const M = this.M;
    const [a0, a1, a2] = M[0];
    const [b0, b1, b2] = M[1];
    const [c0, c1, c2] = M[2];
    for (let i = 0; i < v.length; i += 3) {
      const x = v[i];
      const y = v[i + 1];
      const z = v[i + 2];
      refractInto(a0 * x + a1 * y + a2 * z, b0 * x + b1 * y + b2 * z, c0 * x + c1 * y + c2 * z, out, i);
    }
    return out;
  }

  // Звёзды и созвездия в мировой системе с учётом рефракции (как у планет и спутников).
  transformStars(cat) {
    if (!this.starEnu || this.starEnu.length !== cat.vec.length) this.starEnu = new Float32Array(cat.vec.length);
    this.transformArray(cat.vec, this.starEnu);
    for (const c of cat.constellations) {
      c.lines.forEach((line, k) => this.transformArray(line, c.linesEnu[k]));
      this.transformArray(c.label, c.labelEnu);
    }
    this.starsAt = this.time;
    return this.starEnu;
  }

  // Высота Солнца в произвольный момент (для автотемы по реальному времени).
  sunAltAt(ms) {
    const date = new Date(ms);
    const eq = A.Equator(A.Body.Sun, date, this.observer, true, true);
    return A.Horizon(date, this.observer, eq.ra, eq.dec, 'normal').altitude;
  }

  updateBodies(ms) {
    const date = new Date(ms);
    for (const b of this.bodies) {
      const eq = A.Equator(b.body, date, this.observer, true, true);
      const hor = A.Horizon(date, this.observer, eq.ra, eq.dec, 'normal');
      b.alt = hor.altitude;
      b.az = hor.azimuth;
      const a = b.alt * DEG;
      const z = b.az * DEG;
      b.vec = [Math.cos(a) * Math.sin(z), Math.cos(a) * Math.cos(z), Math.sin(a)];
      b.distAU = eq.dist;
      b.distKm = eq.dist * KM_PER_AU;
      if (b.kind === 'sun') b.radiusDeg = (Math.atan(696000 / b.distKm) / DEG);
      if (b.kind === 'moon') {
        b.radiusDeg = Math.atan(1737.4 / b.distKm) / DEG;
        const ill = A.Illumination(A.Body.Moon, date);
        b.phaseAngle = ill.phase_angle; // угол Солнце–Луна–Земля: 0 — полнолуние, 180 — новолуние
        b.illum = ill.phase_fraction;
        b.mag = ill.mag;
        b.elongation = A.MoonPhase(date); // 0 — новолуние, 180 — полнолуние
      }
    }
    // Звёздные величины меняются медленно — раз в минуту времени неба.
    if (!this.magAt || Math.abs(ms - this.magAt) > 60000) {
      for (const b of this.bodies) {
        if (b.kind === 'planet' || b.kind === 'sun') b.mag = A.Illumination(b.body, date).mag;
      }
      this.magAt = ms;
    }
    this.bodiesAt = ms;
  }

  body(id) {
    return this.bodies.find((b) => b.id === id);
  }

  get sunAlt() {
    return this.body('sun').alt;
  }
}

export { A };
