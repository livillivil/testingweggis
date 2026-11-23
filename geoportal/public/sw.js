/**
 * KMC Public GeoPortal PWA service worker (scope: `/geoportal/`).
 * Owned by the public Next.js portal (`geoportal/`, `basePath: '/geoportal'`).
 *
 * Everything the worker precaches or falls back to must carry the `/geoportal`
 * basePath, otherwise the browser requests origin-root URLs that the portal
 * does not serve. The root scope stays owned by the field workbench worker.
 */

const CACHE_NAME = 'kmc-geoportal-pwa-v3';
const BASE_PATH = '/geoportal';
const OFFLINE_URL = `${BASE_PATH}/`;

const PRECACHE_ASSETS = [
  OFFLINE_URL,
  `${BASE_PATH}/manifest.webmanifest`,
  `${BASE_PATH}/assets/KMC.png`,
  `${BASE_PATH}/assets/Nepal.png`,
  `${BASE_PATH}/assets/Nepal_flag.webp`,
  `${BASE_PATH}/videos/kmc-poster.jpg`,
  `${BASE_PATH}/wards.geojson`,
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
            /* Optional showcase media must not abort the whole install. */
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

  // Public map data comes from FastAPI through the Nginx `/api/` location.
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
