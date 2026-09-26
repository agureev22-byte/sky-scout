// Тесты карты неба: проекция, ориентация телефона, компас, пересчёт звёзд.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as A from '../vendor/astronomy.js';
import { View, enu, altAz, angleBetween } from '../js/sky/view.js';
import { rotationMatrix, cameraAxes, forwardHeading, rotateAzimuth, OrientationTracker } from '../js/sky/orientation.js';
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
  close(forwardHeading(R), 0, 1e-9);
});

test('ориентация: поворот на запад (alpha = 90) и наклон вверх', () => {
  const R = rotationMatrix(90, 90, 0);
  const { f } = cameraAxes(R, 0);
  const aa = altAz(f);
  close(aa.az, 270, 1e-6, 'alpha растёт против часовой — камера на запад');
  const R2 = rotationMatrix(0, 120, 0); // верх телефона отклонён назад — камера смотрит выше горизонта
  close(altAz(cameraAxes(R2, 0).f).alt, 30, 1e-6);
});

test('курс «вперёд» устойчив и плашмя, и вертикально', () => {
  for (const alpha of [0, 33, 200]) {
    const flat = forwardHeading(rotationMatrix(alpha, 0, 0));
    const upright = forwardHeading(rotationMatrix(alpha, 90, 0));
    const tilted = forwardHeading(rotationMatrix(alpha, 50, 0));
    const expected = (360 - alpha) % 360;
    assert.ok(angDiff(flat, expected) < 1e-6);
    assert.ok(angDiff(upright, expected) < 1e-6);
    assert.ok(angDiff(tilted, expected) < 1e-6);
    // телефон задран в небо (камера смотрит вверх под 47°) и почти над головой экраном вниз
    for (const beta of [120, 137, 150, 175]) {
      const R = rotationMatrix(alpha, beta, 0);
      assert.ok(angDiff(forwardHeading(R), expected) < 1e-6, `beta=${beta}`);
      assert.ok(angDiff(altAz(cameraAxes(R, 0).f).az, expected) < 1e-6, `камера beta=${beta}`);
    }
  }
});

test('компас: курс камеры, задранной в небо, берётся из webkitCompassHeading', () => {
  const t = new OrientationTracker();
  t.handle({ alpha: 0, beta: 137, gamma: 0, webkitCompassHeading: 200, webkitCompassAccuracy: 5 }, false);
  const f = t.axes(0, 0, 0).f;
  close(altAz(f).az, 200, 1e-6);
  close(altAz(f).alt, 47, 1e-6);
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
  const alpha = 320; // forwardHeading = 40°
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
