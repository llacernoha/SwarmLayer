// Nombre de la caché para almacenar fragmentos de video
const CACHE_NAME = 'video-fragments';

// Mapa de promesas que esperan por fragmentos específicos
const fragmentWaiters = new Map();

// Evento al instalar el Service Worker
self.addEventListener('install', () => self.skipWaiting());

// Evento al activar el Service Worker
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

// Evento fetch interceptado por el Service Worker
self.addEventListener('fetch', event => {
    const url = event.request.url;

    // Solo manejar solicitudes para fragmentos de video (.m4s, .mp4), aun que podría ser cualquiera
    if (url.includes('.m4s') || url.includes('.mp4')) {
        event.respondWith(handleFragmentRequest(event.request));
    }
});

// Evento para recibir mensajes del hilo principal
self.addEventListener('message', async event => {
    const data = event.data;

    switch (data.type) {
        // Se recibe un fragmento desde otro peer (P2P)
        case 'fragment': {
            const cache = await caches.open(CACHE_NAME);
            const exists = await cache.match(data.url);

            // Almacenar fragmento en caché si aún no existe
            if (!exists) {
                await cache.put(data.url, new Response(data.buffer));
            }

            // Resolver promesa si existe alguien esperando por este fragmento
            if (fragmentWaiters.has(data.url)) {
                fragmentWaiters.get(data.url)(); // Resuelve la promesa
                fragmentWaiters.delete(data.url);
            }

            // Notificar al hilo principal
            notifyClients({
                type: 'fragment',
                url: data.url,
                buffer: data.buffer,
                source: data.source,
                peerId: data.peerId
            });
            break;
        }

        // Fragmento solicitado no se encontró en ningún peer
        case 'fragment-not-found': {
            if (fragmentWaiters.has(data.url)) {
                fragmentWaiters.get(data.url)(); // Resolver la promesa como fallida
                fragmentWaiters.delete(data.url);
            }
            break;
        }
    }
});

// Manejo de solicitudes de fragmentos
async function handleFragmentRequest(request) {
    const cache = await caches.open(CACHE_NAME);
    const match = await cache.match(request);

    // Si existe en caché, devolver desde caché
    if (match) return match;

    // Notificar al hilo principal que se solicita un segmento
    notifyClients({ type: 'segment-requested', url: request.url });

    // Esperar a recibir el fragmento desde P2P
    const received = await waitUntilFragment(request.url, 4000);

    if (received) {
        // Verificar nuevamente en caché después de la espera
        const fromCache = await cache.match(request.url);
        if (fromCache) return fromCache;
    }

    // Solicitar desde servidor como fallback
    const response = await fetch(request);

    // Almacenar en caché
    await cache.put(request, response.clone());

    // Notificar al hilo principal la recepción desde servidor
    notifyClients({
        type: 'fragment',
        url: request.url,
        buffer: await response.clone().arrayBuffer(),
        source: 'http'
    });

    return response;
}

// Función para esperar la llegada de un fragmento por postMessage con timeout
function waitUntilFragment(url, timeout = 4000) {
    return new Promise(resolve => {
        const timer = setTimeout(() => {
            fragmentWaiters.delete(url);
            resolve(false); // No llegó a tiempo
        }, timeout);

        fragmentWaiters.set(url, () => {
            clearTimeout(timer);
            resolve(true); // Fragmento recibido
        });
    });
}

// Función para notificar a todas las pestañas del navegador,
// debido a que, un navegador puede tener varias pestañas abiertas.
async function notifyClients(msg) {
    const clients = await self.clients.matchAll();
    clients.forEach(client => client.postMessage(msg));
}
