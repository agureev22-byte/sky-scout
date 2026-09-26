// Ориентация телефона: DeviceOrientation + компас.
// На iPhone углы alpha отсчитываются от случайного направления, а истинный курс даёт
// webkitCompassHeading (относительно магнитного севера). Мы вычисляем поправку между ними,
// сглаживаем её и добавляем магнитное склонение, чтобы получить направление на истинный север.

import { DEG, cross, dot, norm } from './view.js';

export function orientationSupported() {
  return typeof window !== 'undefined' && 'DeviceOrientationEvent' in window;
}

export function needsPermission() {
  return orientationSupported() && typeof DeviceOrientationEvent.requestPermission === 'function';
}

// На iOS обязательно вызывать прямо из обработчика нажатия (до любых await).
export function requestOrientationPermission() {
  if (!orientationSupported()) return Promise.resolve('unsupported');
  if (!needsPermission()) return Promise.resolve('granted');
  try {
    return DeviceOrientationEvent.requestPermission().then(
      (s) => s,
      () => 'denied',
    );
  } catch {
    return Promise.resolve('denied');
  }
}

// Матрица поворота «устройство → мир (восток, север, вверх)» по углам W3C (Z-X'-Y'').
// Столбцы — оси устройства в мировой системе.
export function rotationMatrix(alpha, beta, gamma) {
  const x = beta * DEG;
  const y = gamma * DEG;
  const z = alpha * DEG;
  const cX = Math.cos(x);
  const cY = Math.cos(y);
  const cZ = Math.cos(z);
  const sX = Math.sin(x);
  const sY = Math.sin(y);
  const sZ = Math.sin(z);
  return [
    [cZ * cY - sZ * sX * sY, -cX * sZ, cY * sZ * sX + cZ * sY],
    [cY * sZ + cZ * sX * sY, cZ * cX, sZ * sY - cZ * cY * sX],
    [-cX * sY, sX, cX * cY],
  ];
}

const col = (m, j) => [m[0][j], m[1][j], m[2][j]];

// Поворот экрана (портрет/альбом), градусы против часовой стрелки.
export function screenAngle() {
  if (typeof screen !== 'undefined' && screen.orientation && typeof screen.orientation.angle === 'number') {
    return screen.orientation.angle;
  }
  if (typeof window !== 'undefined' && typeof window.orientation === 'number') return window.orientation;
  return 0;
}

// Оси камеры в мировой системе по матрице устройства и повороту экрана.
// Задняя камера смотрит вдоль −z устройства.
export function cameraAxes(R, screenDeg = 0) {
  const t = screenDeg * DEG;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const xd = col(R, 0);
  const yd = col(R, 1);
  const zd = col(R, 2);
  const r = [c * xd[0] - s * yd[0], c * xd[1] - s * yd[1], c * xd[2] - s * yd[2]];
  const u = [s * xd[0] + c * yd[0], s * xd[1] + c * yd[1], s * xd[2] + c * yd[2]];
  const f = [-zd[0], -zd[1], -zd[2]];
  return { r, u, f };
}

// Курс «вперёд» в системе датчика: плашмя — куда смотрит верх телефона,
// вертикально — куда смотрит задняя камера, задран в небо — тоже по камере.
// Так же ведёт себя компас iPhone. Горизонтальные проекции камеры (−z) и верха (±y)
// складываются, поэтому курс не вырождается ни при каком наклоне.
export function forwardHeading(R) {
  const y = col(R, 1);
  const z = col(R, 2);
  const s = z[2] >= 0 ? 1 : -1; // экран вверх — «вперёд» это верх телефона, экран вниз — его низ
  const e = s * y[0] - z[0];
  const n = s * y[1] - z[1];
  let h = Math.atan2(e, n) / DEG;
  if (h < 0) h += 360;
  return h;
}

// Поворот вектора вокруг зенита на угол по часовой стрелке (прибавка к азимуту).
export function rotateAzimuth(v, deg) {
  const a = deg * DEG;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [v[0] * c + v[1] * s, -v[0] * s + v[1] * c, v[2]];
}

function wrap180(d) {
  return ((((d + 180) % 360) + 360) % 360) - 180;
}

export class OrientationTracker {
  constructor({ onChange } = {}) {
    this.onChange = onChange || (() => {});
    this.R = null;
    this.lastEvent = 0;
    this.mode = 'none'; // 'ios' | 'absolute' | 'relative'
    this.offset = null; // курс устройства → магнитный курс, градусы
    this.accuracy = null;
    this.smooth = null;
    this.listening = false;
    this._onAbs = (e) => this.handle(e, true);
    this._onRel = (e) => this.handle(e, false);
  }

  start() {
    if (this.listening || typeof window === 'undefined') return;
    this.listening = true;
    if ('ondeviceorientationabsolute' in window) window.addEventListener('deviceorientationabsolute', this._onAbs);
    window.addEventListener('deviceorientation', this._onRel);
  }

  stop() {
    if (!this.listening) return;
    this.listening = false;
    window.removeEventListener('deviceorientationabsolute', this._onAbs);
    window.removeEventListener('deviceorientation', this._onRel);
  }

  get active() {
    return this.R !== null && Date.now() - this.lastEvent < 3000;
  }

  // Есть ли у нас север (компас) или только относительные углы.
  get hasCompass() {
    return this.mode === 'ios' ? this.offset !== null : this.mode === 'absolute';
  }

  handle(e, isAbsoluteEvent) {
    if (e.alpha === null || e.beta === null || e.gamma === null || e.alpha === undefined) return;
    // Если приходят абсолютные события, относительные игнорируем.
    if (!isAbsoluteEvent && this.mode === 'absolute') return;
    const R = rotationMatrix(e.alpha, e.beta, e.gamma);
    const heading = typeof e.webkitCompassHeading === 'number' ? e.webkitCompassHeading : null;
    if (heading !== null && heading >= 0) {
      this.mode = 'ios';
      const acc = typeof e.webkitCompassAccuracy === 'number' ? e.webkitCompassAccuracy : null;
      this.accuracy = acc;
      // У наклона ~45° iOS может переключать, по какой оси считать курс, — там поправку не обновляем.
      const tilt = Math.abs(R[2][2]); // |z устройства · вверх|: 1 — плашмя, 0 — вертикально
      const stable = tilt > 0.8 || tilt < 0.55;
      if (acc === null || acc >= 0) {
        const off = wrap180(heading - forwardHeading(R));
        if (this.offset === null) this.offset = off;
        else if (stable) this.offset = wrap180(this.offset + 0.08 * wrap180(off - this.offset));
      }
    } else if (isAbsoluteEvent || e.absolute === true) {
      this.mode = 'absolute';
      this.offset = 0;
    } else if (this.mode !== 'ios') {
      this.mode = 'relative';
      if (this.offset === null) this.offset = 0;
    }
    this.R = R;
    this.lastEvent = Date.now();
    this.onChange();
  }

  // Оси камеры в истинной (географической) системе.
  // declination — магнитное склонение (восток +), userOffset — ручная калибровка.
  axes(declination = 0, userOffset = 0, smoothing = 0.3) {
    if (!this.R) return null;
    const raw = cameraAxes(this.R, screenAngle());
    // Абсолютные углы (Android) и компас iPhone привязаны к магнитному северу.
    const magnetic = this.mode === 'ios' || this.mode === 'absolute';
    const corr = (this.offset || 0) + (magnetic ? declination : 0) + userOffset;
    let f = rotateAzimuth(raw.f, corr);
    let u = rotateAzimuth(raw.u, corr);
    if (this.smooth && smoothing > 0) {
      const k = smoothing;
      f = norm([this.smooth.f[0] + k * (f[0] - this.smooth.f[0]), this.smooth.f[1] + k * (f[1] - this.smooth.f[1]), this.smooth.f[2] + k * (f[2] - this.smooth.f[2])]);
      u = [this.smooth.u[0] + k * (u[0] - this.smooth.u[0]), this.smooth.u[1] + k * (u[1] - this.smooth.u[1]), this.smooth.u[2] + k * (u[2] - this.smooth.u[2])];
    }
    // ортонормализация: u ⟂ f, правая тройка: r = f × u
    const d = dot(u, f);
    u = norm([u[0] - d * f[0], u[1] - d * f[1], u[2] - d * f[2]]);
    const r = cross(f, u);
    this.smooth = { f, u };
    return { r, u, f };
  }
}
