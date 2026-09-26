#!/usr/bin/env node
// Скачивает TLE с CelesTrak в data/tle/<группа>.txt — копию на сайте, которую приложение берёт,
// если CelesTrak недоступен из браузера (нет сети до него, CORS, ограничение частоты запросов).
// Запускается раз в сутки из .github/workflows/update-tle.yml; можно и вручную:
//   node tools/fetch-tle.mjs            — все группы с копией (stations, visual, hubble)
//   node tools/fetch-tle.mjs hubble     — только указанные
// Старый файл остаётся, если загрузка не удалась или пришли не те данные.
// Каталог data/tle создаётся всегда (даже если ни одного файла не появилось) — на него рассчитан
// шаг `git add -A -- data/tle` в workflow.
// Код выхода ненулевой, только если не удалось обновить ни одну группу. Нужен Node 20+ (глобальный fetch),
// workflow запускает на Node 22.

import { access, mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TLE_GROUPS, parseTle } from '../js/satellites.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TIMEOUT_MS = 60_000;
const USER_AGENT = 'sky-scout-tle-mirror/1 (GitHub Actions; daily)';

// Проверка содержимого: минимальное число спутников и обязательные объекты.
const EXPECT = {
  stations: { min: 3, ids: [25544] },
  visual: { min: 20, ids: [] },
  hubble: { min: 1, ids: [20580] },
};

const normalize = (text) =>
  text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l, i, a) => l || i < a.length - 1)
    .join('\n')
    .trim() + '\n';

async function download(url) {
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/plain' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const body = await res.text();
      return { status: res.status, ok: res.ok, body };
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 5000));
    }
  }
  throw lastErr;
}

async function updateGroup(group) {
  const file = path.join(ROOT, group.mirror);
  const { status, ok, body } = await download(group.url);
  // CelesTrak отвечает 403 с пояснением, если данные не менялись с прошлой загрузки с этого адреса
  // (адреса раннеров GitHub общие, так что это возможно и при самом первом запуске).
  if (!ok && /not updated since your last successful download/i.test(body)) {
    const exists = await access(file).then(
      () => true,
      () => false,
    );
    return {
      changed: false,
      note: exists
        ? 'CelesTrak: данные не обновлялись с прошлой загрузки, файл оставлен'
        : 'CelesTrak: данные не обновлялись с прошлой загрузки с этого адреса; файла копии пока нет — появится при следующем запуске',
    };
  }
  if (!ok) throw new Error(`HTTP ${status}: ${body.slice(0, 120).trim()}`);

  const sats = parseTle(body, group.id);
  const exp = EXPECT[group.id] || { min: 1, ids: [] };
  if (sats.length < exp.min) {
    throw new Error(`в ответе ${sats.length} спутников (нужно не меньше ${exp.min}): ${body.slice(0, 120).trim()}`);
  }
  const missing = exp.ids.filter((id) => !sats.some((s) => s.id === id));
  if (missing.length) throw new Error(`в ответе нет объектов NORAD ${missing.join(', ')}`);

  const text = normalize(body);
  const old = await readFile(file, 'utf8').catch(() => null);
  if (old === text) return { changed: false, count: sats.length, note: 'без изменений' };

  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, file);
  return { changed: true, count: sats.length };
}

async function main() {
  const wanted = process.argv.slice(2);
  const groups = TLE_GROUPS.filter((g) => g.mirror && (!wanted.length || wanted.includes(g.id)));
  if (!groups.length) {
    console.error(`Нет таких групп с копией на сайте: ${wanted.join(', ')}`);
    process.exit(2);
  }
  for (const dir of new Set(groups.map((g) => path.dirname(path.join(ROOT, g.mirror))))) {
    await mkdir(dir, { recursive: true });
  }

  const results = await Promise.all(
    groups.map(async (g) => {
      try {
        const r = await updateGroup(g);
        const what = r.changed ? `обновлено, спутников: ${r.count}` : r.note + (r.count ? `, спутников: ${r.count}` : '');
        console.log(`✓ ${g.id} (${g.mirror}): ${what}`);
        return true;
      } catch (e) {
        console.error(`✗ ${g.id}: ${e?.message || e} — старый файл оставлен`);
        return false;
      }
    }),
  );

  if (!results.some(Boolean)) {
    console.error('Не удалось загрузить ни одной группы TLE.');
    process.exit(1);
  }
}

await main();
