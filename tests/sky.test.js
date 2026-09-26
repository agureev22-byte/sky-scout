// Тесты карты неба: проекция, ориентация телефона, компас, пересчёт звёзд.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as A from '../vendor/astronomy.js';
import { View, enu, altAz, angleBetween } from '../js/sky/view.js';
import { rotationMatrix, cameraAxes, compassReference, rotateAzimuth, OrientationTracker } from '../js/sky/orientation.js';
import { Sky } from '../js/sky/scene.js';

const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} ${a} ≉ ${b} (±${eps})`);
const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

test('enu/altAz — взаимно обратны, азимут от севера по часовой', () => {
  for (const [alt, az] of [[0, 0], [10, 90], [45, 180], [-30, 270], [80, 359]]) {
    const r = altAz(enu(alt, az));
    close(r.alt, alt, 1e-9);
    assert.ok(angDiff(r.az, az) < 1e-9);
  }
  const east = enu(0, 90);
  close(east[0], 1, 1e-12, 'восток — +x');
});

for (const projection of ['stereo', 'gnomonic']) {
  test(`проекция ${projection}: центр экрана = направление взгляда, обратное преобразование`, () => {
    const v = new View();
    v.resize(390, 844);
    v.projection = projection;
    v.fov = 70;
    v.lookAt(135, 25);
    const p = {};
    assert.ok(v.project(enu(25, 135), p));
    close(p.x, 195, 1e-6);
    close(p.y, 422, 1e-6);
    // объект правее по азимуту — правее на экране; выше — выше
    assert.ok(v.project(enu(25, 145), p) && p.x > 195);
    assert.ok(v.project(enu(35, 135), p) && p.y < 422);
    // край поля зрения по ширине
    assert.ok(v.project(enu(0, 0), p) === (projection === 'stereo'));
    for (const [x, y] of [[10, 10], [195, 422], [380, 800], [60, 500]]) {
      const w = v.unproject(x, y);
      assert.ok(v.project(w, p));
      close(p.x, x, 1e-6);
      close(p.y, y, 1e-6);
    }
    // половина поля зрения по меньшей стороне попадает на край
    const half = v.fov / 2;
    v.lookAt(0, 0);
    assert.ok(v.project(enu(0, half), p));
    close(p.x, 390, 1e-6, 'край экрана');
    close(v.effectiveFov, 70, 1e-9);
  });
}

test('ориентация: телефон вертикально, камера на север', () => {
  const R = rotationMatrix(0, 90, 0);
  const { r, u, f } = cameraAxes(R, 0);
  close(f[1], 1, 1e-9, 'камера смотрит на север');
  close(u[2], 1, 1e-9, 'верх экрана — к зениту');
  close(r[0], 1, 1e-9, 'право — на восток');
  close(compassReference(R), 0, 1e-9);
});

test('ориентация: поворот на запад (alpha = 90) и наклон вверх', () => {
  const R = rotationMatrix(90, 90, 0);
  const { f } = cameraAxes(R, 0);
  const aa = altAz(f);
  close(aa.az, 270, 1e-6, 'alpha растёт против часовой — камера на запад');
  const R2 = rotationMatrix(0, 120, 0); // верх телефона отклонён назад — камера смотрит выше горизонта
  close(altAz(cameraAxes(R2, 0).f).alt, 30, 1e-6);
});

// Физическое положение телефона → углы W3C (в системе, где север сдвинут на ref, как у iOS).
function poseEvent(az, alt, roll, ref = 0, heading = az) {
  const f = enu(alt, az);
  const r0 = [Math.cos(az * Math.PI / 180), -Math.sin(az * Math.PI / 180), 0];
  const u0 = [r0[1] * f[2] - r0[2] * f[1], r0[2] * f[0] - r0[0] * f[2], r0[0] * f[1] - r0[1] * f[0]];
  const k = roll * Math.PI / 180;
  const x = r0.map((v, i) => v * Math.cos(k) + u0[i] * Math.sin(k));
  const y = r0.map((v, i) => -v * Math.sin(k) + u0[i] * Math.cos(k));
  const z = f.map((v) => -v);
  const cols = [x, y, z].map((c) => rotateAzimuth(c, -ref)); // система iOS со случайным нулём
  const M = [0, 1, 2].map((i) => cols.map((c) => c[i]));
  const sX = M[2][1];
  const cX = Math.sqrt(Math.max(0, 1 - sX * sX));
  const deg = 180 / Math.PI;
  if (cX < 1e-6) {
    // ровно вертикально: gamma и alpha неразличимы — берём gamma = 0
    return { alpha: Math.atan2(M[1][0], M[0][0]) * deg, beta: sX > 0 ? 90 : -90, gamma: 0, webkitCompassHeading: ((heading % 360) + 360) % 360, webkitCompassAccuracy: 10 };
  }
  return {
    alpha: Math.atan2(-M[0][1] / cX, M[1][1] / cX) * deg,
    beta: Math.atan2(sX, cX) * deg,
    gamma: Math.atan2(-M[2][0] / cX, M[2][2] / cX) * deg,
    webkitCompassHeading: ((heading % 360) + 360) % 360,
    webkitCompassAccuracy: 10,
  };
}

test('эталон компаса: вертикально — курс камеры, плашмя — курс верха, наклон ~45° — нет', () => {
  for (const alpha of [0, 33, 200]) {
    const expected = (360 - alpha) % 360;
    assert.ok(angDiff(compassReference(rotationMatrix(alpha, 0, 0)), expected) < 1e-6, 'плашмя');
    assert.ok(angDiff(compassReference(rotationMatrix(alpha, 90, 0)), expected) < 1e-6, 'вертикально');
    assert.equal(compassReference(rotationMatrix(alpha, 45, 0)), null, 'под 45° не учимся');
    assert.equal(compassReference(rotationMatrix(alpha, 90, 90)), compassReference(rotationMatrix(alpha, 90, 90)));
  }
});

test('компас iPhone: крен и переход через горизонт не сдвигают небо', () => {
  const ref = 73; // случайный ноль alpha у iOS
  for (const roll of [0, 10, -12]) {
    for (const alt of [-2, 2, 20]) {
      const t = new OrientationTracker();
      for (let i = 0; i < 40; i++) t.handle(poseEvent(200, alt, roll, ref), false);
      const aa = altAz(t.axes(0, 0, 0).f);
      assert.ok(angDiff(aa.az, 200) < 1, `крен ${roll}, высота ${alt}: азимут ${aa.az}`);
      close(aa.alt, alt, 1e-6);
    }
  }
  // выучили у горизонта — потом держим поправку и в альбомной ориентации, и под 45°,
  // даже если компас там отвечает иначе
  const t = new OrientationTracker();
  for (let i = 0; i < 10; i++) t.handle(poseEvent(120, 0, 0, ref), false);
  for (let i = 0; i < 60; i++) t.handle(poseEvent(150, 45, 90, ref, 150 + 45), false);
  assert.ok(angDiff(altAz(t.axes(0, 0, 0).f).az, 150) < 1e-6);
});

test('компас iPhone: пока компас не откалиброван (−1), поправка не выдумывается', () => {
  const t = new OrientationTracker();
  for (let i = 0; i < 5; i++) t.handle({ ...poseEvent(200, 45, 0, 73), webkitCompassHeading: -1 }, false);
  assert.equal(t.mode, 'relative');
  assert.equal(t.hasCompass, false);
  // приходит нормальный курс, но телефон под 45° — ждём удобного положения
  t.handle(poseEvent(200, 45, 0, 73), false);
  assert.equal(t.waitingForCompass, true);
  t.handle(poseEvent(200, 5, 0, 73), false);
  assert.equal(t.hasCompass, true);
  t.smooth = null;
  assert.ok(angDiff(altAz(t.axes(0, 0, 0).f).az, 200) < 1e-6);
});

test('альбомная ориентация: оси экрана поворачиваются вместе с ним', () => {
  // телефон вертикально, повёрнут на 90° против часовой (экран в альбомной ориентации)
  const R = rotationMatrix(0, 0, 0);
  const { r, u } = cameraAxes(R, 90);
  // верх экрана = бывшая правая сторона телефона (+x), право экрана = −y
  close(u[0], 1, 1e-9);
  close(r[1], -1, 1e-9);
});

test('компас iPhone: поправка между alpha и webkitCompassHeading', () => {
  const t = new OrientationTracker();
  // iOS: alpha отсчитан от случайного направления. Пусть истинный курс камеры 100°,
  // а в системе датчика тот же курс соответствует alpha, дающей курс 40°.
  const alpha = 320; // курс камеры в системе датчика = 40°
  const ev = { alpha, beta: 90, gamma: 0, webkitCompassHeading: 100, webkitCompassAccuracy: 10 };
  t.handle(ev, false);
  assert.equal(t.mode, 'ios');
  const axes = t.axes(0, 0, 0);
  close(altAz(axes.f).az, 100, 1e-6, 'камера смотрит по компасу');
  // склонение +5° (восточное) — истинный курс больше магнитного
  t.smooth = null;
  close(altAz(t.axes(5, 0, 0).f).az, 105, 1e-6);
  // ручная поправка
  t.smooth = null;
  close(altAz(t.axes(0, -3, 0).f).az, 97, 1e-6);
});

test('rotateAzimuth прибавляет к азимуту по часовой', () => {
  const v = rotateAzimuth(enu(20, 10), 30);
  const aa = altAz(v);
  close(aa.az, 40, 1e-9);
  close(aa.alt, 20, 1e-9);
});

test('звёзды: матрица J2000 → горизонт совпадает с astronomy-engine', () => {
  const sky = new Sky();
  sky.setObserver(41.39, 2.17, 10);
  const ms = Date.parse('2026-09-26T21:00:00Z');
  sky.update(ms, true);
  // Вега, J2000
  const ra = 279.2347;
  const dec = 38.7837;
  const v = [Math.cos(dec * Math.PI / 180) * Math.cos(ra * Math.PI / 180), Math.cos(dec * Math.PI / 180) * Math.sin(ra * Math.PI / 180), Math.sin(dec * Math.PI / 180)];
  const mine = altAz(sky.eqjToEnu(v));
  A.DefineStar(A.Body.Star4, ra / 15, dec, 25);
  const eq = A.Equator(A.Body.Star4, new Date(ms), sky.observer, true, true);
  const hor = A.Horizon(new Date(ms), sky.observer, eq.ra, eq.dec);
  close(mine.alt, hor.altitude, 0.02, 'высота');
  assert.ok(angDiff(mine.az, hor.azimuth) < 0.03, 'азимут');
});

test('Солнце и Луна: положения и фаза', () => {
  const sky = new Sky();
  sky.setObserver(41.39, 2.17, 10);
  // 26 сентября 2026, 12:00 UTC — Солнце на юге Барселоны около полудня по солнцу
  sky.update(Date.parse('2026-09-26T11:50:00Z'), true);
  const sun = sky.body('sun');
  assert.ok(sun.alt > 40 && sun.alt < 50, `высота Солнца ${sun.alt}`);
  assert.ok(angDiff(sun.az, 180) < 10, `азимут Солнца ${sun.az}`);
  const moon = sky.body('moon');
  assert.ok(moon.illum > 0.95, 'полнолуние 26.09.2026');
  assert.ok(moon.distKm > 350000 && moon.distKm < 410000);
  assert.ok(angleBetween(sun.vec, moon.vec) > 170, 'в полнолуние Луна напротив Солнца');
});
