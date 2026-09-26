// Проверка экрана в Chromium с размерами iPhone: подменяем геолокацию, время и ответ Open-Meteo.
// Запуск: node tools/preview.mjs [папка-для-скриншотов]
// Нужен playwright (npm i --no-save playwright или глобальная установка).

import { chromium, devices } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(process.argv[2] || path.join(root, 'preview'));
mkdirSync(outDir, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
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

// Синтетический прогноз в формате Open-Meteo (timeformat=unixtime).
function fakeForecast(url, cloudFn, tz) {
  const u = new URL(url);
  const lat = Number(u.searchParams.get('latitude'));
  const lon = Number(u.searchParams.get('longitude'));
  const days = Number(u.searchParams.get('forecast_days') || 8);
  const now = Date.now();
  const start = Math.floor(now / 86400000) * 86400000 - 2 * 3600000;
  const time = [];
  const cc = [];
  for (let i = 0; i < days * 24; i++) {
    const t = start + i * 3600000;
    time.push(t / 1000);
    cc.push(cloudFn(t, i));
  }
  return {
    latitude: lat,
    longitude: lon,
    utc_offset_seconds: 7200,
    timezone: tz,
    timezone_abbreviation: 'CEST',
    elevation: 12,
    hourly_units: {},
    hourly: {
      time,
      cloud_cover: cc,
      cloud_cover_low: cc,
      cloud_cover_mid: cc.map(() => 0),
      cloud_cover_high: cc.map(() => 0),
      precipitation_probability: cc.map((c) => (c > 90 ? 70 : 5)),
      temperature_2m: time.map((t, i) => 14 - (i % 24) / 5),
      relative_humidity_2m: cc.map(() => 78),
      wind_speed_10m: cc.map(() => 3.2),
    },
  };
}

const scenarios = [
  { name: '01-bcn-day-fullmoon', lat: 41.39, lon: 2.17, tz: 'Europe/Madrid', time: '2026-09-26T14:00:00Z', clouds: () => 5 },
  { name: '02-bcn-cloudy', lat: 41.39, lon: 2.17, tz: 'Europe/Madrid', time: '2026-09-26T14:00:00Z', clouds: (t, i) => (i < 60 ? 95 : i < 110 ? 50 : 5) },
  { name: '03-montsec-night', lat: 42.05, lon: 0.73, tz: 'Europe/Madrid', time: '2026-10-10T21:30:00Z', clouds: () => 4 },
  { name: '04-montsec-day', lat: 42.05, lon: 0.73, tz: 'Europe/Madrid', time: '2026-10-12T10:00:00Z', clouds: (t, i) => (i % 24 > 20 || i % 24 < 3 ? 60 : 8) },
  { name: '05-tromso-polar-day', lat: 69.65, lon: 18.96, tz: 'Europe/Oslo', time: '2026-06-21T12:00:00Z', clouds: () => 20 },
  { name: '06-offline', lat: 41.39, lon: 2.17, tz: 'Europe/Madrid', time: '2026-10-10T15:00:00Z', clouds: null },
];

const iphone = devices['iPhone 13'];
const browser = await chromium.launch();
const errors = [];

for (const s of scenarios) {
  const context = await browser.newContext({
    ...iphone,
    deviceScaleFactor: 2,
    geolocation: { latitude: s.lat, longitude: s.lon },
    permissions: ['geolocation'],
    serviceWorkers: 'block',
    locale: 'ru-RU',
    timezoneId: s.tz,
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${s.name}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${s.name}: console: ${m.text()}`);
  });
  await page.clock.setFixedTime(new Date(s.time));
  await page.route('https://api.open-meteo.com/**', (route) => {
    if (!s.clouds) return route.abort('internetdisconnected');
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(fakeForecast(route.request().url(), s.clouds, s.tz)) });
  });
  await page.goto(base + 'verdict.html');
  // Первый запуск: экран знакомства → «Определить моё место».
  await page.getByRole('button', { name: 'Определить моё место' }).first().click();
  await page.waitForSelector('.headline', { timeout: 15000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(outDir, `${s.name}.png`), fullPage: true });
  const headline = await page.textContent('.headline');
  console.log(`${s.name}: ${headline}`);
  await context.close();
}

// Экран знакомства
{
  const context = await browser.newContext({ ...iphone, deviceScaleFactor: 2, serviceWorkers: 'block', locale: 'ru-RU' });
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date('2026-09-26T21:00:00Z'));
  await page.goto(base + 'verdict.html');
  await page.waitForSelector('#intro:not([hidden])');
  await page.screenshot({ path: path.join(outDir, '00-intro.png'), fullPage: true });
  await page.getByRole('button', { name: 'Выбрать город вручную' }).click();
  await page.screenshot({ path: path.join(outDir, '00-sheet.png') });
  await context.close();
}

await browser.close();
server.close();
if (errors.length) {
  console.error('Ошибки на странице:\n' + errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Готово, скриншоты в ${outDir}`);
}
