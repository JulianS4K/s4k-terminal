// S4K Terminal Service Worker v5.5.4
// Strategy: cache-first for static shell, network-only for GAS API calls

const CACHE = 's4k-v554';
const SHELL = [
  '/s4k-terminal/',
  '/s4k-terminal/index.html',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Always network for GAS proxy calls — never cache live market data
  if (url.hostname.includes('script.google.com') ||
      url.hostname.includes('googleapis.com') ||
      url.hostname.includes('api.ticketevolution.com') ||
      url.hostname.includes('api.anthropic.com')) {
    e.respondWith(fetch(e.request));
    return;
  }

  // Cache-first for static shell
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        // Cache successful GET responses for shell assets
        if (e.request.method === 'GET' && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match('/s4k-terminal/'));
    })
  );
});
