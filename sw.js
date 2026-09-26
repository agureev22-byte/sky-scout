// Сервис-воркер: приложение, каталог городов и расчёты неба работают без интернета.
// Орбиты спутников (TLE) и погоду кэширует само приложение с отметкой времени, здесь их не трогаем.
// Черновик экрана «вердикт» (verdict.html) и его скрипты кэшируются, когда их откроют со связью.
// При изменении любого файла приложения увеличьте VERSION — телефоны скачают новую версию.

const VERSION = 'v3';
const CACHE = `sky-scout-${VERSION}`;

const APP_FILES = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/sky.css',
  'js/sky/main.js',
  'js/sky/view.js',
  'js/sky/scene.js',
  'js/sky/render.js',
  'js/sky/orientation.js',
  'js/sky/camera.js',
  'js/sky/info.js',
  'js/sky/geomag.js',
  'js/satellites.js',
  'js/location.js',
  'js/format.js',
  'js/storage.js',
  'js/theme.js',
  'vendor/astronomy.js',
  'vendor/satellite.js',
  'data/stars.json',
  'data/constellations.json',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(APP_FILES.map((f) => new Request(f, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('sky-scout-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Чужие адреса (Open-Meteo, CelesTrak) идут напрямую в сеть.
  if (url.origin !== self.location.origin) return;
  // Зеркало орбит спутников обновляется раз в сутки — его кэширует само приложение.
  if (url.pathname.includes('/data/tle/')) return;

  // Страница: точное совпадение из кэша той же версии, что и скрипты (иначе новая разметка
  // может встретить старый код). Других страниц (например, verdict.html) в кэше нет —
  // их берём из сети и сохраняем; без сети для главной отдаём сохранённую главную.
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.open(CACHE).then((cache) =>
        cache.match(req, { ignoreSearch: true }).then(
          (hit) =>
            hit ||
            fetch(req)
              .then((res) => {
                if (res.ok && res.type === 'basic') cache.put(req, res.clone());
                return res;
              })
              .catch(() => {
                const scope = new URL(self.registration.scope).pathname;
                const path = new URL(req.url).pathname;
                if (path === scope || path === `${scope}index.html`) return cache.match('index.html');
                return cache.match(req, { ignoreSearch: true }).then((r) => r || Response.error());
              }),
        ),
      ),
    );
    return;
  }

  // Остальное: из кэша, а если файла там нет — из сети с сохранением.
  event.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(req, { ignoreSearch: true }).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok && res.type === 'basic') cache.put(req, res.clone());
            return res;
          }),
      ),
    ),
  );
});
