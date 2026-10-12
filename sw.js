/* Jarvis AI — service worker.
 *
 * Goal: the app shell opens instantly and still opens offline, while never
 * pinning a stale build. Navigation requests are network-first (so a new
 * index.html is picked up as soon as you are online), everything else in the
 * shell is stale-while-revalidate. API traffic is never touched.
 *
 * All paths are relative so this keeps working when the site is served from a
 * sub-path such as https://user.github.io/jarvis-ai/.
 */
const VERSION = 'jarvis-v2';
/* Resolve shell URLs against the worker's own location so the app works from a
   sub-path (user.github.io/jarvis-ai/) and the cache keys are always absolute. */
const abs = (u) => new URL(u, self.location.href).href;
const HTML = abs('./index.html');
const SHELL = [
  './',
  './index.html',
  './brain.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(VERSION);
      // add individually: one missing file must not abort the whole install
      await Promise.all(
        SHELL.map((url) =>
          cache.add(new Request(abs(url), { cache: 'reload' })).catch(() => {})
        )
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Only same-origin app files are cached. Model API calls (Groq, Gemini, …)
  // go straight to the network with their own caching semantics.
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(VERSION);
          cache.put(HTML, fresh.clone());
          return fresh;
        } catch {
          const cache = await caches.open(VERSION);
          return (await cache.match(HTML)) || (await cache.match(abs('./'))) || Response.error();
        }
      })()
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(VERSION);
      const cached = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);
      return cached || (await network) || Response.error();
    })()
  );
});
