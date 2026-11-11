/* Only the public application shell is HTTP cached. API responses, OAuth,
   sessions and financial payloads are deliberately excluded. */
const CACHE = 'kinflow-shell-v3';
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

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      let payload;
      try {
        payload = event.data?.json();
      } catch {
        return;
      }
      if (!payload || !/^[a-f0-9-]{36}$/i.test(payload.familyId)) return;
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows)
        client.postMessage({ type: 'PUSH_REFRESH', familyId: payload.familyId });
      // Server presence is the primary suppression mechanism. This covers a tab becoming
      // visible after the server has already handed the message to the push service.
      if (windows.some((client) => client.visibilityState === 'visible')) return;
      await self.registration.showNotification(
        payload.title === 'Изменение в семейных финансах' ? payload.title : 'Новая транзакция',
        {
          icon: '/icon-192.png',
          badge: '/icon-192.png',
          tag: payload.notificationId,
          data: { familyId: payload.familyId },
        },
      );
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const familyId = event.notification.data?.familyId;
  if (typeof familyId !== 'string' || !/^[a-f0-9-]{36}$/i.test(familyId)) return;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const client = windows.find((window) => new URL(window.url).pathname === '/');
      const url = '/?view=shared-history&family=' + encodeURIComponent(familyId);
      if (client) {
        await client.navigate(url);
        await client.focus();
      } else {
        await self.clients.openWindow(url);
      }
    })(),
  );
});
