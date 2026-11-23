/**
 * KMC Field Data Collection PWA service worker (scope: `/`).
 * Owned by the authenticated Next.js workbench (`frontend/`).
 *
 * Strategy:
 *  - App shell + official assets: precached at install.
 *  - `/api/*`: network-first so field edits always reach PostGIS/FastAPI, cached copy only as offline fallback.
 *  - Navigations: network-first, falling back to the cached shell so the workbench still boots offline.
 *  - Other same-origin GETs: stale-while-revalidate.
 */

const CACHE_NAME = 'kmc-field-pwa-v3';
const OFFLINE_URL = '/';

const PRECACHE_ASSETS = [
  '/',
  '/manifest.webmanifest',
  '/assets/KMC.png',
  '/assets/Nepal.png',
  '/assets/Nepal_flag.webp',
  '/wards.geojson',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await Promise.all(
        PRECACHE_ASSETS.map(async (url) => {
          try {
            await cache.add(new Request(url, { cache: 'reload' }));
          } catch {
            /* A single missing optional asset must not abort the whole install. */
          }
        })
      );
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Field data integrity: never serve stale API answers while the backend is reachable.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          if (response && response.status === 200) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(request, response.clone());
          }
          return response;
        } catch {
          return (await caches.match(request)) || Response.error();
        }
      })()
    );
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch {
          return (await caches.match(request)) || (await caches.match(OFFLINE_URL)) || Response.error();
        }
      })()
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      const network = fetch(request)
        .then(async (response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const cache = await caches.open(CACHE_NAME);
            cache.put(request, response.clone());
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })()
  );
});
