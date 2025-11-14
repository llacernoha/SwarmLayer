self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

const peerInventory = new Map();
const pendingFragments = new Map();

function postMessage(data) {
    // Envía el mensaje a todas las pestañas
    self.clients.matchAll().then(list => {
        for (const c of list) c.postMessage(data);
    });
}
self.addEventListener('fetch', event => {
    const url = event.request.url;
    if (!url.includes('.m4s') && !url.includes('.mp4') ) return;

    event.respondWith((async () => {
        const cache = await caches.open('video-fragments');

        // 1) Cache local
        const fromCache = await cache.match(url);
        if (fromCache) {
            return fromCache;
        }

        // 2) Buscar peers que lo tienen
        const peersWith = [];
        const peersWithFragments = [];
        peerInventory.forEach((urls, peerId) => {
            if (urls.has(url)) peersWith.push(peerId);
            peersWithFragments.push(peerId);
        });

        // 3) Si hay peers, solicitamos y esperamos
        if (peersWith.length > 0) {
            const peerId = peersWith[Math.floor(Math.random() * peersWith.length)];

            postMessage({ type: 'p2p-fragment-request', url, peerId, peersWith, peersWithFragments });

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

                // Una vez resuelta la promesa, obtener desde cache
                const fragment = await cache.match(url);
                if (fragment) return fragment;

            } catch (err) {
                //
            }
        }
        // 4) Fallback HTTP
        const resp = await fetch(event.request);
        let size = 0;

        if (resp.ok) {
            // Intentar obtener tamaño del header
            const contentLength = resp.headers.get('content-length');
            if (contentLength) {
                size = parseInt(contentLength, 10);
            } else {
                // Si no viene del header, calcularlo
                const buffer = await resp.clone().arrayBuffer(); 
                size = buffer.byteLength;
            }
            // Clonamos la respuesta ya que se consume y la necesitamos tanto para caché, calcular el tamaño y el return
            await cache.put(url, resp.clone());
        }

        // Notificar fragmento recibido
        postMessage({ type: 'http-fragment-received', url, size, peersWith, peersWithFragments });

        return resp;
    })());
});

self.addEventListener('message', async event => {
    const data = event.data;
    switch (data.type) {

        case 'p2p-fragment-received':
            if (data.url && pendingFragments.has(data.url)) {
                pendingFragments.get(data.url)(); // resuelve la promesa
                pendingFragments.delete(data.url);
            }
            break;

        case 'peerInventory':
            peerInventory.set(data.peerId, new Set(data.urls));
            break;

        case 'peer-disconnected':
            peerInventory.delete(data.peerId);
            break;

        case 'livePeers': {
            const live = new Set(data.peers || []);
            for (const peerId of peerInventory.keys()) {
                if (!live.has(peerId)) {
                    peerInventory.delete(peerId);
                }
            }
            break;
        }
    }


});
