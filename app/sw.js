/*
 * Service worker de la versión web instalable.
 * La página siempre se pide primero a la red, para no quedarse en una versión vieja.
 * Los archivos con hash no cambian nunca: se guardan al usarlos y así el editor abre sin conexión.
 */
const CACHE = 'fanccini-mw8rxbls';
const CORE = ['./', 'index.html', 'manifest.webmanifest', 'logo.svg', 'icon-192.png', 'apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('fanccini-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

const keep = async (req, res) => { if (res.ok && res.type === 'basic') { const c = await caches.open(CACHE); await c.put(req, res.clone()); } return res; };

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || !url.pathname.startsWith(new URL('./', location.href).pathname)) return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((r) => keep('index.html', r)).catch(async () => (await caches.match('index.html')) ?? Response.error()));
    return;
  }
  if (url.pathname.includes('/assets/')) {
    e.respondWith(caches.match(req).then((hit) => hit ?? fetch(req).then((r) => keep(req, r))));
    return;
  }
  e.respondWith(caches.match(req).then((hit) => {
    const fresh = fetch(req).then((r) => keep(req, r));
    if (hit) { e.waitUntil(fresh.catch(() => {})); return hit; }
    return fresh;
  }));
});
