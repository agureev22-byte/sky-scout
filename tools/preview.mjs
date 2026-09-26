// Проверка карты неба в Chromium с эмуляцией iPhone: геолокация, время, датчики ориентации,
// камера (фальшивая), спутники (синтетические TLE вместо CelesTrak).
// Запуск: node tools/preview.mjs [папка-для-скриншотов]
// Нужен playwright (npm i --no-save playwright или глобальная установка).

import { chromium, devices } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(process.argv[2] || path.join(root, 'preview'));
mkdirSync(outDir, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(root, p);
    if (!file.startsWith(root)) throw new Error('bad path');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

const fixturePath = path.join(root, 'tests/fixtures/tle-test.txt');
const fixture = existsSync(fixturePath) ? await readFile(fixturePath, 'utf8') : '';
// Разделяем фикстуру: Starlink отдельно, остальное — «станции/яркие».
function tleFor(url) {
  const lines = fixture.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
  const groups = [];
  for (let i = 0; i + 2 < lines.length + 1; ) {
    if (lines[i].startsWith('1 ') || lines[i].startsWith('2 ')) { i++; continue; }
    groups.push(lines.slice(i, i + 3).join('\n'));
    i += 3;
  }
  const isStarlink = (g) => g.startsWith('STARLINK');
  if (url.includes('GROUP=starlink')) return groups.filter(isStarlink).join('\n') + '\n';
  if (url.includes('CATNR=20580')) return groups.filter((g) => g.includes('\n1 20580')).join('\n') + '\n';
  return groups.filter((g) => !isStarlink(g)).join('\n') + '\n';
}

const iphone = devices['iPhone 13'];
const errors = [];
const browser = await chromium.launch({
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});

async function newPage({ time, lat = 41.39, lon = 2.17, camera = false }) {
  const context = await browser.newContext({
    ...iphone,
    deviceScaleFactor: 2,
    geolocation: { latitude: lat, longitude: lon },
    permissions: camera ? ['geolocation', 'camera'] : ['geolocation'],
    serviceWorkers: 'block',
    locale: 'ru-RU',
    timezoneId: 'Europe/Madrid',
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/ERR_|Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  await page.clock.install({ time: new Date(time) });
  await page.clock.resume();
  await page.route('https://celestrak.org/**', (route) =>
    route.fulfill({ contentType: 'text/plain', body: tleFor(route.request().url()) }),
  );
  await page.route('https://geocoding-api.open-meteo.com/**', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ results: [{ name: 'Теруэль', latitude: 40.34, longitude: -1.1, elevation: 915, admin1: 'Арагон', country: 'Испания', timezone: 'Europe/Madrid' }] }) }),
  );
  return { context, page };
}

// Эмуляция iPhone: события ориентации с webkitCompassHeading (камера смотрит на azimuth, alt).
// Как человек: сначала телефон к горизонту (iPhone «ловит» компас), потом на цель.
// alpha у iOS отсчитывается от случайного направления — берём сдвиг 73°.
async function pointPhone(page, az, alt) {
  await page.evaluate(({ az, alt }) => {
    clearInterval(window.__orientTimer);
    const ref = 73;
    const fire = (a) => {
      const e = new Event('deviceorientation');
      const decl = window.__sky.state.declination || 0;
      Object.assign(e, {
        alpha: (((360 - az + ref) % 360) + 360) % 360,
        beta: 90 + a,
        gamma: 0,
        absolute: false,
        webkitCompassHeading: ((az - decl) % 360 + 360) % 360,
        webkitCompassAccuracy: 5,
      });
      window.dispatchEvent(e);
    };
    for (let i = 0; i < 5; i++) fire(2);
    fire(alt);
    window.__orientTimer = setInterval(() => fire(alt), 30);
  }, { az, alt });
  await page.waitForTimeout(700);
}

const shot = (page, name) => page.screenshot({ path: path.join(outDir, `${name}.png`) });

try {
  // ---- 1. Ночь, первый запуск, ручной режим ----
  {
    const { context, page } = await newPage({ time: '2026-09-26T20:30:00Z' });
    await page.goto(base);
    await page.waitForSelector('#welcome:not([hidden])');
    await shot(page, '01-welcome');
    await page.getByRole('button', { name: 'Без датчиков — крутить пальцем' }).click();
    await page.waitForSelector('#welcome', { state: 'hidden' });
    await page.waitForFunction(() => window.__sky.state.cat && window.__sky.state.sats.length > 0, null, { timeout: 15000 });
    await page.waitForTimeout(600);
    const theme = await page.evaluate(() => document.documentElement.dataset.theme);
    assert.equal(theme, 'red', 'ночью в режиме «авто» включается красная тема');
    await shot(page, '02-manual-night-red');

    // тёмная тема
    await page.evaluate(() => { localStorage.setItem('sky-scout:theme-v1', '"dark"'); });
    await page.click('#menu-btn');
    await page.click('[data-theme-mode="dark"]');
    await page.click('#settings-sheet [data-close]');
    await page.waitForTimeout(300);
    await shot(page, '03-manual-night-dark');

    // Навести на Луну через поиск и открыть карточку
    await page.click('#find-btn');
    await page.waitForSelector('#find-sheet:not([hidden])');
    await shot(page, '04-find');
    await page.locator('#find-list button', { hasText: 'Луна' }).first().click();
    await page.waitForTimeout(900);
    const moonCard = await page.textContent('#card');
    assert.match(moonCard, /Луна/);
    assert.match(moonCard, /Фаза/);
    assert.match(moonCard, /км/);
    await shot(page, '05-moon-card');

    // Тап по Сатурну на экране (карточку Луны сначала закрываем)
    await page.click('#card-close');
    const target = await page.evaluate(() => {
      const s = window.__sky;
      const b = s.sky.body('saturn');
      s.settings.manual.az = b.az;
      s.settings.manual.alt = Math.max(5, b.alt);
      s.state.dirty = true;
      return b.alt;
    });
    await page.waitForTimeout(400);
    const hit = await page.evaluate(() => window.__sky.renderer.hits.find((h) => h.type === 'body' && h.id === 'saturn'));
    assert.ok(hit, 'Сатурн на экране');
    await page.mouse.click(hit.x, hit.y);
    await page.waitForTimeout(400);
    assert.match(await page.textContent('#card'), /Сатурн/);
    assert.match(await page.textContent("#card"), /а\.\sе\./);
    await shot(page, '06-saturn-card');

    // МКС: карточка с пролётами
    await page.click('#find-btn');
    const issRow = page.locator('#find-list button', { hasText: 'МКС' });
    assert.ok(await issRow.count(), 'МКС есть в списке');
    await issRow.first().click();
    await page.waitForTimeout(900);
    const issCard = await page.textContent('#card');
    assert.match(issCard, /МКС/);
    assert.match(issCard, /пролёт/i);
    await shot(page, '07-iss-card');

    // Шкала времени
    const t0 = await page.textContent('#time-main');
    await page.click('[data-step="3600000"]');
    await page.waitForTimeout(300);
    const t1 = await page.textContent('#time-main');
    assert.notEqual(t0, t1, 'время сдвинулось');
    assert.match(await page.textContent("#time-offset"), /\+1\sч/);
    await shot(page, '08-time-plus1h');
    await page.click('#now-btn');
    await page.waitForTimeout(300);
    assert.equal(await page.textContent('#time-offset'), 'сейчас');
    await context.close();
  }

  // ---- 2. День: Солнце, датчики ----
  {
    const { context, page } = await newPage({ time: '2026-09-26T12:00:00Z' });
    await page.goto(base);
    await page.getByRole('button', { name: 'Начать' }).click();
    await page.waitForSelector('#welcome', { state: 'hidden' });
    await page.waitForFunction(() => window.__sky.state.cat, null, { timeout: 15000 });
    const sun = await page.evaluate(() => { const b = window.__sky.sky.body('sun'); return { az: b.az, alt: b.alt }; });
    // Сразу высоко в небо: компас iPhone ещё не пойман — должна быть подсказка.
    await page.evaluate(() => {
      const e = new Event('deviceorientation');
      Object.assign(e, { alpha: 10, beta: 140, gamma: 0, webkitCompassHeading: 200, webkitCompassAccuracy: 5 });
      window.dispatchEvent(e);
    });
    await page.waitForTimeout(300);
    assert.match(await page.textContent('#compass-chip'), /Ловлю компас/);
    assert.equal(await page.isVisible('#banner'), false, 'баннер «датчики не отвечают» не висит при живых датчиках');
    await shot(page, '09a-compass-waiting');
    await pointPhone(page, sun.az, sun.alt);
    assert.equal(await page.isVisible('#compass-chip'), false, 'компас пойман — подсказка ушла');
    const mode = await page.evaluate(() => window.__sky.settings.mode);
    assert.equal(mode, 'sensors', 'после «Начать» — режим датчиков');
    const hint = await page.textContent('#center-hint');
    assert.match(hint, /Солнце/, `в прицеле Солнце, а не «${hint}»`);
    await shot(page, '09-day-sensors-sun');
    // повернуть телефон на 90° правее — Солнце уходит за край, есть стрелка
    await page.evaluate(() => window.__sky.select({ type: 'body', id: 'sun' }));
    await pointPhone(page, sun.az + 90, 10);
    await shot(page, '10-day-arrow-to-sun');
    await context.close();
  }

  // ---- 3. AR с фальшивой камерой, ночь ----
  {
    const { context, page } = await newPage({ time: '2026-09-26T21:30:00Z', camera: true });
    await page.goto(base);
    await page.getByRole('button', { name: 'Начать' }).click();
    await page.waitForSelector('#welcome', { state: 'hidden' });
    await page.waitForFunction(() => window.__sky.state.cat, null, { timeout: 15000 });
    const moon = await page.evaluate(() => { const b = window.__sky.sky.body('moon'); return { az: b.az, alt: b.alt }; });
    await pointPhone(page, moon.az, moon.alt);
    await page.click('#mode-btn');
    await page.click('[data-mode="ar"]');
    await page.waitForTimeout(1500);
    const ar = await page.evaluate(() => ({ mode: window.__sky.settings.mode, playing: !document.getElementById('camera').paused, w: document.getElementById('camera').videoWidth }));
    assert.equal(ar.mode, 'ar');
    assert.ok(ar.w > 0, 'видео с камеры идёт');
    assert.match(await page.textContent('#center-hint'), /Луна/);
    await shot(page, '11-ar-moon');
    await context.close();
  }

  // ---- 3б. Альбомная ориентация: карточка читается ----
  {
    const { context, page } = await newPage({ time: '2026-09-26T20:30:00Z' });
    await page.setViewportSize({ width: 844, height: 390 });
    await page.goto(base);
    await page.getByRole('button', { name: 'Без датчиков — крутить пальцем' }).click();
    await page.waitForSelector('#welcome', { state: 'hidden' });
    await page.waitForFunction(() => window.__sky.state.cat, null, { timeout: 15000 });
    await page.click('#find-btn');
    await page.locator('#find-list button', { hasText: 'Луна' }).first().click();
    await page.waitForTimeout(800);
    const box = await page.locator('#card').boundingBox();
    assert.ok(box.height >= 96, `высота карточки ${box.height}`);
    await shot(page, '13-landscape-moon');
    await context.close();
  }

  // ---- 4. Выбор места вручную ----
  {
    const { context, page } = await newPage({ time: '2026-09-26T21:30:00Z' });
    await context.clearPermissions();
    await page.goto(base);
    await page.getByRole('button', { name: 'Без датчиков — крутить пальцем' }).click();
    await page.waitForSelector('#place-sheet:not([hidden])');
    await shot(page, '12-place-sheet');
    await page.fill('#search-input', 'Теруэль');
    await page.locator('#search-results button').first().click();
    await page.waitForSelector('#welcome', { state: 'hidden' });
    assert.equal(await page.textContent('#place-name'), 'Теруэль');
    await context.close();
  }
} catch (err) {
  errors.push(`проверка: ${err.message}`);
} finally {
  await browser.close();
  server.close();
}

if (errors.length) {
  console.error(`Ошибки:\n${errors.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`Все проверки пройдены. Скриншоты: ${outDir}`);
}
