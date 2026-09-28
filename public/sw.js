/* Only the public application shell is HTTP cached. API responses, OAuth,
   sessions and financial payloads are deliberately excluded. */
const CACHE = 'kinflow-shell-v2';
async function cacheShell() {
  const cache = await caches.open(CACHE);
  const response = await fetch('/');
  if (!response.ok) throw new Error('Shell unavailable');
  const html = await response.clone().text();
  await cache.put('/', response);
  const urls = [
    ...new Set(
      [...html.matchAll(/(?:src|href)="([^"<>]+)"/g)]
        .map((m) => m[1].replaceAll('&amp;', '&'))
        .filter((url) => url.startsWith('/_next/static/')),
    ),
  ];
  await Promise.all(
    urls.map(async (url) => {
      try {
        await cache.add(url);
      } catch {}
    }),
  );
  await cache.addAll(['/icon.svg', '/manifest.webmanifest']);
}
self.addEventListener('install', (event) => {
  event.waitUntil(cacheShell());
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'CACHE_ASSETS' || !Array.isArray(event.data.urls)) return;
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await Promise.all(
        event.data.urls.slice(0, 200).map(async (value) => {
          try {
            const url = new URL(value, self.location.origin);
            if (url.origin === self.location.origin && url.pathname.startsWith('/_next/static/'))
              await cache.add(url.href);
          } catch {}
        }),
      );
      event.ports[0]?.postMessage('ready');
    })(),
  );
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/api/')
  )
    return;
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(async (response) => {
          if (response.ok) {
            const cache = await caches.open(CACHE);
            await cache.put('/', response.clone());
          }
          return response;
        })
        .catch(() => caches.match('/')),
    );
    return;
  }
  if (
    url.pathname.startsWith('/_next/static/') ||
    ['/icon.svg', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest'].includes(url.pathname)
  )
    event.respondWith(
      caches.match(event.request).then(
        (cached) =>
          cached ||
          fetch(event.request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(CACHE).then((cache) => cache.put(event.request, copy));
            }
            return response;
          }),
      ),
    );
});
