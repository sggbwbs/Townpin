// Deliberately conservative. This site's whole value is *live* data
// (board availability, news, events, weather, chat answers) -- an
// aggressive cache-first service worker is exactly the kind of thing
// that quietly leaves visitors stuck looking at yesterday's board after
// a deploy. So this only ever does two things:
//
// 1. Cache the bare app shell (the HTML document + manifest) so a
//    repeat visit paints instantly even on a slow connection, and so
//    there's SOMETHING to show if the visitor is genuinely offline.
// 2. Never intercept /api/* at all -- every board, feed, weather, and
//    chat request always goes straight to the network, full stop.
//
// Network-first, not cache-first: the network response is preferred and
// re-cached every time it succeeds; the cache is only a fallback for
// when the network request itself fails (actually offline).

const CACHE_NAME = 'paikalliscanvas-shell-v2';
const SHELL_URLS = ['/', '/oulu', '/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_URLS))
      .catch(() => {}) // best-effort -- a failed pre-cache shouldn't block install
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) return; // never cache or intercept API calls

  event.respondWith(
    // cache:'no-store' forces this past the browser's own HTTP cache,
    // not just the separate Service Worker Cache API above -- without
    // it, fetch() here is still subject to normal Cache-Control
    // behavior, meaning "network-first" in intent could still end up
    // silently served from the browser's local HTTP cache in practice,
    // with the request never actually reaching the network at all.
    // Confirmed as a real, reproducible cause of "I deployed a green
    // build but the site still shows the old version" for at least one
    // real visitor -- not just a theoretical concern.
    fetch(event.request, { cache: 'no-store' })
      .then(res => {
        const resClone = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, resClone)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
