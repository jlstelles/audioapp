/* Service worker do AudioApp: guarda só os arquivos do próprio app.
   Nunca intercepta áudio, transmissões de rádio nem pedidos de outros sites. */
const CACHE = 'audioapp-v1';
const SHELL = [
  './', './index.html', './style.css', './app.js', './manifest.webmanifest',
  './icon.svg', './icon-192.png', './icon-512.png', './icon-maskable-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;     // rádios e outros sites: direto na rede
  if (req.headers.has('range') || req.destination === 'audio' || req.destination === 'video') return;

  // arquivos do app: usa o guardado e atualiza em segundo plano
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(cached => {
      const net = fetch(req).then(res => {
        if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
        return res;
      }).catch(() => cached);
      return cached || net;
    })
  );
});
