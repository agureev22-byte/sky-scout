// Рисование неба на canvas. Всё в CSS-пикселях, масштаб под Retina задаётся трансформацией.

import { enu, DEG, apparentAlt } from './view.js';

// Точка на небе с учётом рефракции (спутники считаются геометрически).
const skyVec = (alt, az) => enu(apparentAlt(alt), az);
import { starName } from './scene.js';

const PALETTES = {
  dark: {
    skyNight: '#02040a',
    skyTwilight: '#0a1530',
    skyDay: '#173a70',
    ground: 'rgba(6, 10, 9, 0.74)',
    groundAR: 'rgba(0, 0, 0, 0.28)',
    horizon: 'rgba(150, 190, 140, 0.9)',
    cardinal: '#cfe0bd',
    cardinalMain: '#f2f7e9',
    grid: 'rgba(120, 145, 200, 0.2)',
    constLine: 'rgba(105, 145, 230, 0.5)',
    constLabel: 'rgba(150, 180, 255, 0.8)',
    stars: ['#a9c1ff', '#f4f6ff', '#fff6e6', '#ffe8c2', '#ffd09c', '#ffb577'],
    label: '#eef1f8',
    labelDim: '#aab3c8',
    labelShadow: 'rgba(0,0,0,0.85)',
    sat: '#e6f6ff',
    satFeatured: '#8fe3ff',
    satShadow: '#6f7890',
    trail: 'rgba(143, 227, 255, 0.85)',
    select: '#ffd36b',
    reticle: 'rgba(255,255,255,0.55)',
    moonDark: 'rgba(40, 46, 60, 0.9)',
    sunGlow: 'rgba(255, 215, 106, 0.55)',
    bodyColors: true,
  },
  // Только красный: зелёная и синяя составляющие не больше 0x18, иначе глаза теряют привычку к темноте.
  // Состояния различаем яркостью и толщиной линий, а не оттенком.
  red: {
    skyNight: '#000000',
    skyTwilight: '#060000',
    skyDay: '#100000',
    ground: 'rgba(12, 0, 0, 0.8)',
    groundAR: 'rgba(0, 0, 0, 0.3)',
    horizon: 'rgba(200, 16, 8, 0.9)',
    cardinal: '#b01408',
    cardinalMain: '#ff2410',
    grid: 'rgba(140, 10, 4, 0.3)',
    constLine: 'rgba(160, 14, 6, 0.6)',
    constLabel: 'rgba(210, 22, 10, 0.85)',
    stars: ['#ff2a14', '#ff2a14', '#ff2a14', '#ff2a14', '#ff2a14', '#ff2a14'],
    label: '#e81c0c',
    labelDim: '#a01208',
    labelShadow: 'rgba(0,0,0,0.9)',
    sat: '#ff2a14',
    satFeatured: '#ff3018',
    satShadow: '#6a0c04',
    trail: 'rgba(255, 36, 16, 0.85)',
    select: '#ff3018',
    reticle: 'rgba(230, 20, 8, 0.6)',
    moonDark: 'rgba(36, 0, 0, 0.9)',
    sunGlow: 'rgba(255, 24, 8, 0.4)',
    bodyColors: false,
  },
};

const CARDINALS = [
  [0, 'С', true], [45, 'СВ'], [90, 'В', true], [135, 'ЮВ'], [180, 'Ю', true], [225, 'ЮЗ'], [270, 'З', true], [315, 'СЗ'],
];

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// Грубая «видимость» звёзд на карте в зависимости от высоты Солнца.
function starLimit(fov, sunAlt, ar) {
  let lim = fov > 100 ? 4.8 : fov > 70 ? 5.2 : fov > 45 ? 5.6 : 6.0;
  if (ar) lim = Math.min(lim, 5.0);
  if (sunAlt > -6) lim = Math.min(lim, 3.2);
  return lim;
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = 1;
    this.hits = [];
    this.labels = [];
    this.p = { x: 0, y: 0, z: 0 };
    this.q = { x: 0, y: 0, z: 0 };
  }

  resize(w, h, dpr) {
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
  }

  // ---- подписи без наложений ----
  placeLabel(text, x, y, font, color, { force = false, align = 'left', dx = 8, dy = 4, alpha = 1 } = {}) {
    const ctx = this.ctx;
    ctx.font = font;
    const w = ctx.measureText(text).width;
    // высота — размер шрифта в px (строка шрифта может начинаться с жирности: «600 14px …»)
    const h = Number((/(\d+(?:\.\d+)?)px/.exec(font) || [0, 12])[1]);
    const W = this.W || 1e9;
    let lx = align === 'center' ? x - w / 2 : x + dx;
    // у правого края — подпись слева от точки; в любом случае не вылезаем за экран
    if (align !== 'center' && lx + w > W - 4) lx = x - dx - w;
    lx = Math.max(4, Math.min(W - w - 4, lx));
    const ly = y + dy;
    const rect = [lx - 2, ly - h, lx + w + 2, ly + 3];
    // под верхней панелью кнопок подписи не рисуем (кроме обязательных)
    if (!force && rect[1] < (this.topInset || 0)) return false;
    if (!force) {
      for (const r of this.labels) {
        if (rect[0] < r[2] && rect[2] > r[0] && rect[1] < r[3] && rect[3] > r[1]) return false;
      }
    }
    this.labels.push(rect);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = this.pal.labelShadow;
    ctx.fillText(text, lx + 1, ly + 1);
    ctx.fillStyle = color;
    ctx.fillText(text, lx, ly);
    ctx.globalAlpha = 1;
    return true;
  }

  draw(s) {
    const { view, sky, cat } = s;
    const ctx = this.ctx;
    const pal = (this.pal = PALETTES[s.theme] || PALETTES.dark);
    const W = view.width;
    const H = view.height;
    const F = view.focal;
    const fov = view.effectiveFov;
    const ar = s.mode === 'ar';
    this.hits = [];
    this.labels = [];
    this.bodyLabels = [];
    this.W = W;
    this.topInset = s.insets ? s.insets.top - 20 : 0;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.textBaseline = 'alphabetic';

    // ---- фон ----
    const sunAlt = sky.sunAlt;
    if (ar) {
      ctx.clearRect(0, 0, W, H);
    } else {
      ctx.fillStyle = sunAlt > 0 ? pal.skyDay : sunAlt > -12 ? pal.skyTwilight : pal.skyNight;
      ctx.fillRect(0, 0, W, H);
    }

    const p = this.p;
    const q = this.q;

    // ---- сетка высот и азимутов ----
    if (s.layers.grid) this.drawGrid(view, F);

    // ---- линии созвездий ----
    if (cat && s.layers.constellations) {
      ctx.strokeStyle = pal.constLine;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const maxJump = Math.max(W, H) * 0.8;
      for (const c of cat.constellations) {
        for (const line of c.linesEnu) {
          let prevOk = false;
          let px = 0;
          let py = 0;
          for (let k = 0; k < line.length; k += 3) {
            const ok = view.projectXYZ(line[k], line[k + 1], line[k + 2], p, F);
            if (ok && prevOk && Math.abs(p.x - px) + Math.abs(p.y - py) < maxJump) {
              ctx.moveTo(px, py);
              ctx.lineTo(p.x, p.y);
            }
            prevOk = ok;
            px = p.x;
            py = p.y;
          }
        }
      }
      ctx.stroke();
    }

    // ---- звёзды ----
    if (cat && s.layers.stars) {
      const se = s.starEnu;
      const lim = starLimit(fov, sunAlt, ar);
      const zoom = clamp(Math.sqrt(80 / fov), 0.8, 1.9);
      const buckets = pal.stars.map(() => []);
      for (let i = 0; i < cat.count; i++) {
        const m = cat.mag[i];
        if (m > lim) break; // каталог отсортирован по яркости
        if (!view.projectXYZ(se[3 * i], se[3 * i + 1], se[3 * i + 2], p, F)) continue;
        if (p.x < -10 || p.x > W + 10 || p.y < -10 || p.y > H + 10) continue;
        const r = clamp(0.55 + (5.3 - m) * 0.4, 0.55, 3.8) * zoom;
        buckets[cat.color[i]].push(p.x, p.y, r, m);
        // яркие звёзды важнее соседних тусклых: подсказка «в прицеле» назовёт именно их
        if (m < 3.6 || cat.names[cat.hip[i]]) this.hits.push({ x: p.x, y: p.y, prio: m < 1 ? 2 : m < 2.5 ? 1 : 0, type: 'star', index: i });
      }
      buckets.forEach((b, ci) => {
        ctx.fillStyle = pal.stars[ci];
        for (const faint of [false, true]) {
          ctx.globalAlpha = faint ? 0.6 : 1;
          ctx.beginPath();
          for (let k = 0; k < b.length; k += 4) {
            if ((b[k + 3] > 4.3) !== faint) continue;
            ctx.moveTo(b[k] + b[k + 2], b[k + 1]);
            ctx.arc(b[k], b[k + 1], b[k + 2], 0, 2 * Math.PI);
          }
          ctx.fill();
        }
      });
      ctx.globalAlpha = 1;
      // ореол у самых ярких
      for (let i = 0; i < cat.count && cat.mag[i] < 1.0; i++) {
        if (!view.projectXYZ(se[3 * i], se[3 * i + 1], se[3 * i + 2], p, F) || !view.isOnScreen(p, 20)) continue;
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 9 * zoom);
        g.addColorStop(0, pal.stars[cat.color[i]]);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = g;
        ctx.fillRect(p.x - 10 * zoom, p.y - 10 * zoom, 20 * zoom, 20 * zoom);
      }
      ctx.globalAlpha = 1;
    }

    // ---- названия созвездий ----
    if (cat && s.layers.constellations && s.layers.labels) {
      const maxRank = fov > 110 ? 1 : fov > 70 ? 2 : 3;
      for (const c of cat.constellations) {
        if (c.rank > maxRank) continue;
        const v = c.labelEnu;
        if (!view.projectXYZ(v[0], v[1], v[2], p, F) || !view.isOnScreen(p, -10)) continue;
        this.placeLabel(c.name.toUpperCase(), p.x, p.y, '600 11px -apple-system, system-ui, sans-serif', pal.constLabel, { align: 'center', dy: 0 });
      }
    }

    // ---- земля и горизонт ----
    this.drawGround(view, F, ar);
    if (s.layers.labels) this.drawCardinals(view, F);

    // ---- подписи ярких звёзд (после земли, чтобы не прятались) ----
    if (cat && s.layers.stars && s.layers.labels) {
      const se = s.starEnu;
      const labelMag = fov > 100 ? 1.3 : fov > 60 ? 2.0 : fov > 35 ? 3.0 : 4.0;
      for (const i of cat.named) {
        const m = cat.mag[i];
        if (m > labelMag) continue;
        if (!view.projectXYZ(se[3 * i], se[3 * i + 1], se[3 * i + 2], p, F) || !view.isOnScreen(p, -4)) continue;
        const below = se[3 * i + 2] < 0;
        this.placeLabel(starName(cat, i), p.x, p.y, '12px -apple-system, system-ui, sans-serif', pal.labelDim, { alpha: below ? 0.45 : 0.95 });
      }
    }

    // ---- спутники ----
    if (s.sats && s.layers.satellites) this.drawSatellites(s, view, F);

    // ---- Солнце, Луна, планеты ----
    if (s.layers.planets) {
      const order = [...sky.bodies].sort((a, b) => (b.distAU || 0) - (a.distAU || 0));
      for (const b of order) this.drawBody(b, sky, view, F, s);
      // подписи — после всех дисков, чтобы Луна не закрывала имя соседней планеты
      for (const l of this.bodyLabels) this.placeLabel(...l);
    }

    // ---- выбранный объект ----
    if (s.selection) this.drawSelection(s, view, F);

    // ---- прицел в режимах датчиков ----
    if (s.mode !== 'manual') {
      ctx.strokeStyle = pal.reticle;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(W / 2, H / 2, 16, 0, 2 * Math.PI);
      ctx.moveTo(W / 2 - 26, H / 2);
      ctx.lineTo(W / 2 - 20, H / 2);
      ctx.moveTo(W / 2 + 20, H / 2);
      ctx.lineTo(W / 2 + 26, H / 2);
      ctx.moveTo(W / 2, H / 2 - 26);
      ctx.lineTo(W / 2, H / 2 - 20);
      ctx.moveTo(W / 2, H / 2 + 20);
      ctx.lineTo(W / 2, H / 2 + 26);
      ctx.stroke();
    }
  }

  drawGrid(view, F) {
    const ctx = this.ctx;
    const p = this.p;
    ctx.strokeStyle = this.pal.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const maxJump = Math.max(view.width, view.height) * 0.5;
    for (const alt of [30, 60]) {
      let prev = null;
      for (let az = 0; az <= 360; az += 3) {
        const ok = view.project(enu(alt, az), p, F);
        if (ok && prev && Math.abs(p.x - prev.x) + Math.abs(p.y - prev.y) < maxJump) {
          ctx.moveTo(prev.x, prev.y);
          ctx.lineTo(p.x, p.y);
        }
        prev = ok ? { x: p.x, y: p.y } : null;
      }
    }
    for (let az = 0; az < 360; az += 30) {
      let prev = null;
      for (let alt = 0; alt <= 88; alt += 4) {
        const ok = view.project(enu(alt, az), p, F);
        if (ok && prev && Math.abs(p.x - prev.x) + Math.abs(p.y - prev.y) < maxJump) {
          ctx.moveTo(prev.x, prev.y);
          ctx.lineTo(p.x, p.y);
        }
        prev = ok ? { x: p.x, y: p.y } : null;
      }
    }
    ctx.stroke();
  }

  // Земля — полупрозрачная заливка ниже горизонта; горизонт — линия.
  // Земля собирается из четырёхугольников «высота × азимут», каждый обрезается
  // плоскостью перед камерой (иначе у краёв обзора появляются дыры).
  drawGround(view, F, ar) {
    const ctx = this.ctx;
    const gnomonic = view.projection === 'gnomonic';
    const zMin = gnomonic ? 0.05 : -0.85;
    const bands = [0, -8, -20, -40, -65, -89.5];
    const step = 6;
    const maxEdge = Math.max(view.width, view.height) * 0.75;
    const o = { x: 0, y: 0 };
    ctx.beginPath();
    for (let az = 0; az < 360; az += step) {
      for (let k = 0; k < bands.length - 1; k++) {
        const cam = [
          view.toCamera(enu(bands[k], az)),
          view.toCamera(enu(bands[k], az + step)),
          view.toCamera(enu(bands[k + 1], az + step)),
          view.toCamera(enu(bands[k + 1], az)),
        ];
        // Сазерленд — Ходжмен: оставляем часть многоугольника с z ≥ zMin
        const poly = [];
        for (let i = 0; i < 4; i++) {
          const a = cam[i];
          const b = cam[(i + 1) % 4];
          const inA = a[2] >= zMin;
          const inB = b[2] >= zMin;
          if (inA) poly.push(a);
          if (inA !== inB) {
            const t = (zMin - a[2]) / (b[2] - a[2]);
            poly.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, zMin]);
          }
        }
        if (poly.length < 3) continue;
        const pts = poly.map((c) => {
          view.projectCamera(c, o, F);
          return { x: o.x, y: o.y };
        });
        if (!gnomonic) {
          // в стереографической проекции у точки, противоположной взгляду, всё «разлетается»
          let big = false;
          for (let i = 0; i < pts.length; i++) {
            const a = pts[i];
            const b = pts[(i + 1) % pts.length];
            if (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) > maxEdge) big = true;
          }
          if (big) continue;
        }
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.closePath();
      }
    }
    ctx.fillStyle = ar ? this.pal.groundAR : this.pal.ground;
    ctx.fill('nonzero');

    // линия горизонта
    const p = this.p;
    ctx.strokeStyle = this.pal.horizon;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let prev = null;
    const maxJump = Math.max(view.width, view.height) * 0.5;
    for (let az = 0; az <= 360; az += 2) {
      const ok = view.project(enu(0, az), p, F);
      if (ok && prev && Math.abs(p.x - prev.x) + Math.abs(p.y - prev.y) < maxJump) {
        ctx.moveTo(prev.x, prev.y);
        ctx.lineTo(p.x, p.y);
      }
      prev = ok ? { x: p.x, y: p.y } : null;
    }
    ctx.stroke();
  }

  drawCardinals(view, F) {
    const p = this.p;
    for (const [az, text, main] of CARDINALS) {
      if (!view.project(enu(1.2, az), p, F) || !view.isOnScreen(p, -6)) continue;
      this.placeLabel(
        text,
        p.x,
        p.y,
        main ? '700 17px -apple-system, system-ui, sans-serif' : '600 13px -apple-system, system-ui, sans-serif',
        main ? this.pal.cardinalMain : this.pal.cardinal,
        { align: 'center', dy: -4, force: true },
      );
    }
  }

  drawBody(b, sky, view, F, s) {
    const ctx = this.ctx;
    const pal = this.pal;
    const p = this.p;
    if (!view.project(b.vec, p, F) || !view.isOnScreen(p, 40)) return;
    const centerOnScreen = view.isOnScreen(p, 0);
    const below = b.alt < -0.5;
    const alpha = below ? 0.42 : 1;
    const pxPerDeg = F * DEG;
    const color = pal.bodyColors ? b.color : pal.label;
    ctx.globalAlpha = alpha;
    let r;
    if (b.kind === 'sun') {
      r = Math.max(11, b.radiusDeg * pxPerDeg);
      const g = ctx.createRadialGradient(p.x, p.y, r * 0.6, p.x, p.y, r * 3);
      g.addColorStop(0, pal.sunGlow);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 3, 0, 2 * Math.PI);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, 2 * Math.PI);
      ctx.fill();
    } else if (b.kind === 'moon') {
      r = Math.max(13, b.radiusDeg * pxPerDeg);
      this.drawMoon(b, sky, view, F, p.x, p.y, r, color);
    } else {
      r = clamp(2.6 + (1.0 - (b.mag ?? 1)) * 0.55, 1.4, 5.5);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, 2 * Math.PI);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    // Центр за краем экрана — подпись не рисуем: если объект выбран, к нему покажет стрелка.
    if (s.layers.labels && centerOnScreen) {
      // Солнце, Луна и яркие планеты подписаны всегда; Уран и Нептун — если есть место.
      const bright = b.kind !== 'planet' || (b.mag ?? 9) < 3;
      this.bodyLabels.push([b.name, p.x, p.y, bright ? '600 14px -apple-system, system-ui, sans-serif' : '12px -apple-system, system-ui, sans-serif', bright ? pal.label : pal.labelDim, {
        force: bright,
        dx: r + 5,
        alpha: below ? 0.55 : 1,
      }]);
    }
    this.hits.push({ x: p.x, y: p.y, r, prio: 3, type: 'body', id: b.id });
  }

  // Луна с правильной фазой: освещённый край повёрнут к Солнцу.
  drawMoon(b, sky, view, F, x, y, r, color) {
    const ctx = this.ctx;
    const sun = sky.body('sun');
    const mv = b.vec;
    const sv = sun.vec;
    const d = mv[0] * sv[0] + mv[1] * sv[1] + mv[2] * sv[2];
    const t = [sv[0] - d * mv[0], sv[1] - d * mv[1], sv[2] - d * mv[2]];
    const tl = Math.hypot(t[0], t[1], t[2]) || 1;
    const eps = 0.01;
    const toward = [mv[0] + (eps * t[0]) / tl, mv[1] + (eps * t[1]) / tl, mv[2] + (eps * t[2]) / tl];
    const q = this.q;
    let angle = 0;
    if (view.project(toward, q, F)) angle = Math.atan2(q.y - y, q.x - x);
    const k = Math.cos((b.phaseAngle ?? 90) * DEG); // 1 — полнолуние, −1 — новолуние
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.fillStyle = this.pal.moonDark;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, 2 * Math.PI);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, -r);
    ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, false);
    ctx.ellipse(0, 0, Math.max(0.01, Math.abs(k) * r), r, 0, Math.PI / 2, -Math.PI / 2, k < 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  drawSatellites(s, view, F) {
    const ctx = this.ctx;
    const pal = this.pal;
    const p = this.p;
    const { sats, satPos } = s;
    const fov = view.effectiveFov;
    const showLabels = s.layers.labels;
    // хвосты — куда летят главные спутники
    if (s.tails) {
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = pal.trail;
      ctx.globalAlpha = 0.6;
      for (const tail of s.tails) this.polyline(tail.points, view, F, (pt) => pt.alt > -1, true);
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
    const dotsLit = [];
    const dotsDark = [];
    const dotsBelow = [];
    for (let i = 0; i < sats.length; i++) {
      const pos = satPos[i];
      if (!pos) continue;
      const sat = sats[i];
      const important = sat.featured || sat.group === 'stations';
      if (pos.alt < 0 && !important) continue;
      const v = skyVec(pos.alt, pos.az);
      if (!view.project(v, p, F) || !view.isOnScreen(p, 10)) continue;
      const starlink = sat.group === 'starlink';
      const r = sat.featured ? 4 : starlink ? 1.5 : 2.2;
      if (sat.featured) {
        ctx.globalAlpha = pos.alt < 0 ? 0.4 : 1;
        ctx.fillStyle = pos.sunlit ? pal.satFeatured : pal.satShadow;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, 2 * Math.PI);
        ctx.fill();
        ctx.strokeStyle = pos.sunlit ? pal.satFeatured : pal.satShadow;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 3.5, 0, 2 * Math.PI);
        ctx.stroke();
        ctx.globalAlpha = 1;
        if (showLabels) {
          this.placeLabel(sat.name, p.x, p.y, '700 14px -apple-system, system-ui, sans-serif', pos.sunlit ? pal.satFeatured : pal.labelDim, {
            force: true,
            dx: r + 6,
            alpha: pos.alt < 0 ? 0.5 : 1,
          });
        }
      } else {
        (pos.alt < 0 ? dotsBelow : pos.sunlit ? dotsLit : dotsDark).push(p.x, p.y, r);
        if (showLabels && !starlink && fov < 60 && pos.sunlit && pos.alt > 0) {
          this.placeLabel(sat.name, p.x, p.y, '11px -apple-system, system-ui, sans-serif', pal.labelDim, { dx: 5, alpha: 0.85 });
        }
      }
      this.hits.push({ x: p.x, y: p.y, r, prio: sat.featured ? 4 : starlink ? 1 : 2, type: 'sat', index: i });
    }
    for (const [list, color, alpha] of [[dotsBelow, pal.satShadow, 0.4], [dotsDark, pal.satShadow, 0.8], [dotsLit, pal.sat, 1]]) {
      if (!list.length) continue;
      ctx.fillStyle = color;
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      for (let k = 0; k < list.length; k += 3) {
        ctx.moveTo(list[k] + list[k + 2], list[k + 1]);
        ctx.arc(list[k], list[k + 1], list[k + 2], 0, 2 * Math.PI);
      }
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // Ломаная по точкам {alt, az}; разрыв там, где точка не видна или filter=false.
  // refract=true — точки спутника (геометрические), поднимаем их рефракцией, как звёзды.
  polyline(points, view, F, filter, refract = false) {
    const ctx = this.ctx;
    const p = this.p;
    const maxJump = Math.max(view.width, view.height) * 0.5;
    ctx.beginPath();
    let prev = null;
    for (const pt of points) {
      const ok = (!filter || filter(pt)) && view.project(refract ? skyVec(pt.alt, pt.az) : enu(pt.alt, pt.az), p, F);
      if (ok && prev && Math.abs(p.x - prev.x) + Math.abs(p.y - prev.y) < maxJump) {
        ctx.moveTo(prev.x, prev.y);
        ctx.lineTo(p.x, p.y);
      }
      prev = ok ? { x: p.x, y: p.y } : null;
    }
    ctx.stroke();
  }

  drawSelection(s, view, F) {
    const ctx = this.ctx;
    const pal = this.pal;
    const sel = s.selection;
    const p = this.p;

    // траектория выбранного спутника: освещённые участки — сплошной линией, в тени — пунктиром
    if (sel.track && sel.track.length > 1) {
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = pal.trail;
      ctx.globalAlpha = 0.95;
      this.polyline(sel.track, view, F, (pt) => pt.alt >= 0 && pt.sunlit, true);
      ctx.setLineDash([4, 5]);
      ctx.globalAlpha = 0.7;
      this.polyline(sel.track, view, F, (pt) => pt.alt >= 0 && !pt.sunlit, true);
      ctx.globalAlpha = 0.3;
      this.polyline(sel.track, view, F, (pt) => pt.alt < 0, true);
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      // отметки времени
      for (const pt of sel.track) {
        if (!pt.tick || pt.alt < 0) continue;
        if (!view.project(skyVec(pt.alt, pt.az), p, F) || !view.isOnScreen(p)) continue;
        ctx.fillStyle = pal.trail;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.5, 0, 2 * Math.PI);
        ctx.fill();
        if (pt.label) this.placeLabel(pt.label, p.x, p.y, '11px -apple-system, system-ui, sans-serif', pal.labelDim, { dx: 6, dy: 12 });
      }
    }

    if (!sel.vec) return;
    // Тот же критерий, что у подписи объекта: центр на экране и не под карточкой — кольцо, иначе — стрелка.
    const inFront = view.project(sel.vec, p, F);
    const occ = s.occluder;
    const underCard = inFront && occ && p.x > occ.left && p.x < occ.right && p.y > occ.top && p.y < occ.bottom;
    const onScreen = inFront && view.isOnScreen(p, 0) && !underCard;
    if (onScreen) {
      ctx.strokeStyle = pal.select;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 20, 0, 2 * Math.PI);
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 25, 0, 2 * Math.PI);
      ctx.stroke();
      return;
    }
    // Объект за краем экрана — стрелка, куда повернуть телефон.
    const v = sel.vec;
    const W = view.width;
    const H = view.height;
    const insetTop = s.insets ? s.insets.top : 80;
    const insetBottom = s.insets ? s.insets.bottom : 120;
    const cx = W / 2;
    const cy = (insetTop + (H - insetBottom)) / 2;
    let ang;
    if (underCard) {
      // объект на экране, но под карточкой — стрелка от середины видимой части прямо к нему
      ang = Math.atan2(p.y - cy, p.x - cx);
    } else {
      const x = view.r[0] * v[0] + view.r[1] * v[1] + view.r[2] * v[2];
      const y = view.u[0] * v[0] + view.u[1] * v[1] + view.u[2] * v[2];
      ang = Math.atan2(-y, x);
    }
    const hw = W / 2 - 34;
    const hh = (H - insetBottom - insetTop) / 2 - 30;
    const dx = Math.cos(ang);
    const dy = Math.sin(ang);
    const t = Math.min(Math.abs(hw / (dx || 1e-9)), Math.abs(hh / (dy || 1e-9)));
    const ax = cx + dx * t;
    const ay = cy + dy * t;
    ctx.save();
    ctx.translate(ax, ay);
    ctx.rotate(ang);
    ctx.fillStyle = pal.select;
    ctx.beginPath();
    ctx.moveTo(16, 0);
    ctx.lineTo(-8, -11);
    ctx.lineTo(-3, 0);
    ctx.lineTo(-8, 11);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    const lx = ax - dx * 34;
    const ly = ay - dy * 30;
    this.placeLabel(sel.name, lx, ly, '700 14px -apple-system, system-ui, sans-serif', pal.select, { force: true, align: 'center', dy: 5 });
  }

  // Ближайший объект к точке касания.
  hitTest(x, y, radius = 30) {
    let best = null;
    let bestScore = Infinity;
    for (const h of this.hits) {
      const d = Math.hypot(h.x - x, h.y - y);
      if (d > radius + (h.r || 0)) continue;
      const score = d - h.prio * 7;
      if (score < bestScore) {
        bestScore = score;
        best = h;
      }
    }
    return best;
  }
}
