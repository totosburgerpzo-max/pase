// Service worker de Pase: la app abre aunque no haya internet. La API de Supabase nunca pasa
// por aquí (siempre va a la red); lo que se firma sin conexión lo guarda la app en IndexedDB.
const VERSION = '%VERSION%';
const ARCHIVOS = %ARCHIVOS%;
const CACHE = `pase-${VERSION}`;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ARCHIVOS)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

// La app pide activar la versión nueva cuando nadie está a mitad de una planilla
self.addEventListener('message', (e) => {
  if (e.data === 'activar') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (e.request.mode === 'navigate') {
    // La página: primero la red (para tener la última versión), si no hay, la guardada
    e.respondWith(fetch(e.request).catch(() => caches.match('/', { cacheName: CACHE })));
    return;
  }
  e.respondWith((async () => {
    const guardado = await caches.match(e.request, { cacheName: CACHE });
    if (guardado) return guardado;
    const r = await fetch(e.request);
    if (r.ok && url.pathname.startsWith('/fuentes/')) {
      const c = await caches.open(CACHE);
      c.put(e.request, r.clone());
    }
    return r;
  })());
});
