// Рендер PNG-иконок из icons/icon.svg через Chromium (Playwright).
// Запуск: node tools/make-icons.mjs  (нужен установленный playwright)
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(path.join(root, 'icons/icon.svg'), 'utf8');

const targets = [
  { file: 'icons/icon-192.png', size: 192, pad: 0 },
  { file: 'icons/icon-512.png', size: 512, pad: 0 },
  { file: 'icons/apple-touch-icon.png', size: 180, pad: 0 },
  // «maskable»: система может обрезать края до круга — оставляем поля
  { file: 'icons/icon-maskable-512.png', size: 512, pad: 0.1 },
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const t of targets) {
  const inner = Math.round(t.size * (1 - 2 * t.pad));
  await page.setViewportSize({ width: t.size, height: t.size });
  await page.setContent(`<html><body style="margin:0;background:#04060c;display:grid;place-items:center;width:${t.size}px;height:${t.size}px">
    <div style="width:${inner}px;height:${inner}px">${svg.replace('<svg ', `<svg width="${inner}" height="${inner}" `)}</div></body></html>`);
  await page.screenshot({ path: path.join(root, t.file), omitBackground: false });
  console.log('✓', t.file);
}
await browser.close();
