const CACHE_NAME = 'video-fragments';
const peerInventory = new Map();
let peer_id = null;
const pendingFragments = new Map();

self.addEventListener('install', (event) => {
    self.skipWaiting(); // Forzar activación inmediata
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        // Se activa en todas las páginas
        await self.clients.claim();
    })());
});

async function sendMetric(metric) {
    try {
        await fetch('https://dashp2p.infinitebuffer.com/ktor/metric', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(metric)
        });
    } catch (err) {
    }
}


// Devuelve nombre fragmentos cacheados
async function getLocalInventory() {
    const cache = await caches.open(CACHE_NAME);
    const requests = await cache.keys();
    return requests.map(req => req.url);
}



self.addEventListener('fetch', event => {

    const url = event.request.url;
    if (!url.includes('.m4s') && !url.includes('.mp4') && !url.includes('.dash')) return;


    event.respondWith((async () => {
        const clients = await self.clients.matchAll();
        const cache = await caches.open(CACHE_NAME);

        // 1) Cache local
        const fromCache = await cache.match(event.request);
        if (fromCache) {
            return fromCache;
        }

        // 2) Buscar peers que lo tienen
        const peersWith = [];
        peerInventory.forEach((urls, peerId) => {
            if (urls.has(url)) peersWith.push(peerId);
        });

        // 3) Si hay peers, solicitamos y esperamos hasta 2 s
        if (peersWith.length > 0) {
            const peerId = peersWith[Math.floor(Math.random() * peersWith.length)];

            // Enviar mensaje a peer.js para que soliciten el fragmento
            clients.forEach(c => {
                c.postMessage({ type: 'send-fragment-request', url, peerId });
            });

            try {
                // Esperar hasta 2 segundos a que el fragmento llegue a caché
                await new Promise((resolve, reject) => {
                    const timer = setTimeout(() => {
                        pendingFragments.delete(url);
                        reject();
                    }, 2000);

                    pendingFragments.set(url, () => {
                        clearTimeout(timer);
                        resolve();
                    });
                });

                // Una vez resuelta la promesa, intentar obtener del cache
                const fragment = await cache.match(event.request);
                if (fragment) {


                    // Notificar nuevo inventario
                    const localInventory = await getLocalInventory();
                    clients.forEach(c => {
                        c.postMessage({ type: 'send-inventory', urls: localInventory });
                    });

                    // Obtener tamaño en bytes
                    const buffer = await fragment.clone().arrayBuffer();
                    const size = buffer.byteLength;
                    // Enviar métrica
                    await sendMetric({
                        fragmentUrl: url,
                        source: 'p2p',
                        sender: xx,
                        receiver: xx,
                        time: Date.now(),
                        sizeBytes: size
                    });

                    return fragment;
                }

            } catch (err) {
                // Si no llegó en 2 s, se hará el fetch HTTP
            }
        }
        // 4) Fallback HTTP
        const resp = await fetch(event.request);
        if (resp.ok) {
            await cache.put(event.request, resp.clone());
        }

        // Notificar nuevo inventario
        const localInventory = await getLocalInventory();
        clients.forEach(c => {
            c.postMessage({ type: 'send-inventory', peerId: peer_id, urls: localInventory });
        });

        // Obtener tamaño en bytes
        const buffer = await resp.clone().arrayBuffer();
        const size = buffer.byteLength;

        // Enviar métrica
        await sendMetric({
            source: 'http',
            fragmentUrl: url,
            timestamp: Date.now(),
            senderPeerId: '',
            receiverPeerId: peer_id,
            sizeBytes: size
        });

        return resp;
    })());
});

self.addEventListener('message', async event => {
    const { type, peerId, url, urls, buffer } = event.data;

    switch (type) {
        case 'peerId':
            peer_id = peerId;
            break;

        case 'fragment-received':
            const cache = await caches.open(CACHE_NAME);
            const exists = await cache.match(url);

            if (!exists) {
                const headers = new Headers({
                    'Content-Type': 'application/octet-stream'
                });

                const response = new Response(buffer, { headers });
                await cache.put(url, response);
            }


            if (url && pendingFragments.has(url)) {
                pendingFragments.get(url)(); // resuelve la promesa
                pendingFragments.delete(url);
            }
            break;

        case 'peerInventory':
            if (peerId && Array.isArray(urls)) {
                peerInventory.set(peerId, new Set(urls));
            }
            break;

        case 'peer-disconnected':
            peerInventory.delete(peerId);
            break;
    }

});
