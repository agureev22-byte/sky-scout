// Камера и проекция неба на экран.
// Мировая система — ENU: x — восток, y — север, z — вверх (зенит).
// Азимут отсчитывается от севера по часовой стрелке (90° — восток).

export const DEG = Math.PI / 180;

export function enu(altDeg, azDeg) {
  const a = altDeg * DEG;
  const z = azDeg * DEG;
  const c = Math.cos(a);
  return [c * Math.sin(z), c * Math.cos(z), Math.sin(a)];
}

export function altAz(v) {
  const alt = Math.asin(Math.max(-1, Math.min(1, v[2]))) / DEG;
  let az = Math.atan2(v[0], v[1]) / DEG;
  if (az < 0) az += 360;
  return { alt, az };
}

export function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function norm(a) {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

// Угловое расстояние между направлениями, градусы.
export function angleBetween(a, b) {
  return Math.acos(Math.max(-1, Math.min(1, dot(norm(a), norm(b))))) / DEG;
}

// Атмосферная рефракция, градусы: поднимает объекты у горизонта.
// Та же формула, что у astronomy-engine (Horizon(..., 'normal')), чтобы звёзды, созвездия,
// спутники и планеты у горизонта сдвигались одинаково.
export function refraction(altDeg) {
  if (altDeg > 89.99) return 0;
  const h = altDeg < -1 ? -1 : altDeg;
  let r = 1.02 / Math.tan((h + 10.3 / (h + 5.11)) * DEG) / 60;
  if (altDeg < -1) r *= (altDeg + 90) / 89;
  return r;
}

// Видимая (с рефракцией) высота по геометрической.
export function apparentAlt(altDeg) {
  return altDeg + refraction(altDeg);
}

// То же для единичного вектора (восток, север, вверх); результат пишется в out[k..k+2].
export function refractInto(e, n, u, out, k) {
  const alt = Math.asin(u < -1 ? -1 : u > 1 ? 1 : u) / DEG;
  const r = refraction(alt);
  if (r === 0) {
    out[k] = e;
    out[k + 1] = n;
    out[k + 2] = u;
    return;
  }
  const alt2 = (alt + r) * DEG;
  const h = Math.sqrt(Math.max(1e-12, e * e + n * n));
  const c = Math.cos(alt2) / h;
  out[k] = e * c;
  out[k + 1] = n * c;
  out[k + 2] = Math.sin(alt2);
}

// Камера: оси right (r), up (u), forward (f) в мировой системе.
// Проекция: 'stereo' (стереографическая — широкий обзор без сильных искажений)
// или 'gnomonic' (прямолинейная — как у объектива камеры, нужна для AR).
export class View {
  constructor() {
    this.width = 390;
    this.height = 844;
    this.r = [1, 0, 0];
    this.u = [0, 0, 1];
    this.f = [0, 1, 0];
    this.projection = 'stereo';
    this.fov = 90; // градусы по меньшей стороне экрана
    this.focalOverride = null; // в AR фокус задаёт камера
  }

  resize(width, height) {
    this.width = width;
    this.height = height;
  }

  get cx() {
    return this.width / 2;
  }

  get cy() {
    return this.height / 2;
  }

  get focal() {
    if (this.focalOverride) return this.focalOverride;
    const half = Math.min(this.width, this.height) / 2;
    const a = (this.fov / 2) * DEG;
    return this.projection === 'gnomonic' ? half / Math.tan(a) : half / (2 * Math.tan(a / 2));
  }

  // Поле зрения по меньшей стороне (для AR — вычисленное из фокуса), градусы.
  get effectiveFov() {
    if (!this.focalOverride) return this.fov;
    const half = Math.min(this.width, this.height) / 2;
    return this.projection === 'gnomonic'
      ? (2 * Math.atan(half / this.focalOverride)) / DEG
      : (4 * Math.atan(half / (2 * this.focalOverride))) / DEG;
  }

  // Ручной режим: направление взгляда по азимуту и высоте, горизонт горизонтален.
  lookAt(azDeg, altDeg) {
    const alt = Math.max(-90, Math.min(90, altDeg));
    const z = azDeg * DEG;
    this.f = enu(alt, azDeg);
    this.r = [Math.cos(z), -Math.sin(z), 0];
    this.u = cross(this.r, this.f);
  }

  setAxes(r, u, f) {
    this.r = r;
    this.u = u;
    this.f = f;
  }

  get center() {
    return altAz(this.f);
  }

  // Проекция мирового вектора (единичного) на экран.
  // Возвращает true, если точка перед камерой; координаты — в out.x, out.y (CSS-пиксели).
  project(v, out, F = this.focal) {
    const x = this.r[0] * v[0] + this.r[1] * v[1] + this.r[2] * v[2];
    const y = this.u[0] * v[0] + this.u[1] * v[1] + this.u[2] * v[2];
    const z = this.f[0] * v[0] + this.f[1] * v[1] + this.f[2] * v[2];
    if (this.projection === 'gnomonic') {
      if (z < 0.02) return false;
      out.x = this.width / 2 + (F * x) / z;
      out.y = this.height / 2 - (F * y) / z;
    } else {
      if (z < -0.9) return false;
      const k = (2 * F) / (1 + z);
      out.x = this.width / 2 + k * x;
      out.y = this.height / 2 - k * y;
    }
    out.z = z;
    return true;
  }

  // Координаты в системе камеры: x — вправо, y — вверх, z — вперёд.
  toCamera(v) {
    return [
      this.r[0] * v[0] + this.r[1] * v[1] + this.r[2] * v[2],
      this.u[0] * v[0] + this.u[1] * v[1] + this.u[2] * v[2],
      this.f[0] * v[0] + this.f[1] * v[1] + this.f[2] * v[2],
    ];
  }

  // Проекция точки, заданной в системе камеры (не обязательно единичной длины).
  projectCamera(c, out, F = this.focal) {
    let [x, y, z] = c;
    if (this.projection === 'gnomonic') {
      out.x = this.width / 2 + (F * x) / z;
      out.y = this.height / 2 - (F * y) / z;
    } else {
      const l = Math.hypot(x, y, z) || 1;
      x /= l;
      y /= l;
      z /= l;
      const k = (2 * F) / (1 + z);
      out.x = this.width / 2 + k * x;
      out.y = this.height / 2 - k * y;
    }
    return out;
  }

  // Быстрая версия для массивов координат.
  projectXYZ(vx, vy, vz, out, F) {
    const x = this.r[0] * vx + this.r[1] * vy + this.r[2] * vz;
    const y = this.u[0] * vx + this.u[1] * vy + this.u[2] * vz;
    const z = this.f[0] * vx + this.f[1] * vy + this.f[2] * vz;
    if (this.projection === 'gnomonic') {
      if (z < 0.02) return false;
      out.x = this.width / 2 + (F * x) / z;
      out.y = this.height / 2 - (F * y) / z;
    } else {
      if (z < -0.9) return false;
      const k = (2 * F) / (1 + z);
      out.x = this.width / 2 + k * x;
      out.y = this.height / 2 - k * y;
    }
    out.z = z;
    return true;
  }

  // Экранная точка → направление в мире.
  unproject(sx, sy) {
    const F = this.focal;
    const X = (sx - this.width / 2) / F;
    const Y = -(sy - this.height / 2) / F;
    let cx;
    let cy;
    let cz;
    if (this.projection === 'gnomonic') {
      const l = Math.hypot(X, Y, 1);
      cx = X / l;
      cy = Y / l;
      cz = 1 / l;
    } else {
      // обратная стереографическая проекция (с учётом множителя 2F)
      const p2 = X * X + Y * Y;
      cx = (4 * X) / (4 + p2);
      cy = (4 * Y) / (4 + p2);
      cz = (4 - p2) / (4 + p2);
    }
    return norm([
      this.r[0] * cx + this.u[0] * cy + this.f[0] * cz,
      this.r[1] * cx + this.u[1] * cy + this.f[1] * cz,
      this.r[2] * cx + this.u[2] * cy + this.f[2] * cz,
    ]);
  }

  isOnScreen(p, margin = 0) {
    return p.x >= -margin && p.x <= this.width + margin && p.y >= -margin && p.y <= this.height + margin;
  }
}
