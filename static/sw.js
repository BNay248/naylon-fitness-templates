// Bump CACHE_NAME whenever static files change.
const CACHE_NAME = 'templates-shell-v2';
const CORE_ASSETS = [
  '/',
  '/static/style.css',
  '/static/common.js',
  '/static/workout-ui.js',
  '/static/offline.js',
  '/static/library-ui.js',
  '/static/template-run.js',
  '/static/template-builder.js',
  '/static/manifest.json',
  '/static/NFP.jpg',
  '/static/icon-192.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(CORE_ASSETS.map(url => new Request(url, { cache: 'reload' })))).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Network-first for everything we serve (so updates show up immediately when online),
// falling back to the cache so the app still opens with no connection.
self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return; // writes go through the page's own offline queue
  const url = new URL(request.url);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return; // app JS handles API offline fallback

  event.respondWith(
    // cache: 'no-cache' makes the browser revalidate its HTTP cache too; otherwise it can hand back days-old JS.
    // (Fetched by URL because a navigation Request can't be re-issued with a different cache mode.)
    fetch(request.url, { cache: 'no-cache', credentials: 'same-origin' })
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
        }
        return res;
      })
      .catch(() => caches.match(request, { ignoreSearch: true }).then(cached => cached || (request.mode === 'navigate' ? caches.match('/') : undefined)))
  );
});
