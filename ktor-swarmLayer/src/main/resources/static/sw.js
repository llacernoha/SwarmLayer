const CACHE_NAME = 'video-fragments';
const peerInventory = new Map();          // { peerId → Set(urls) }
const fragmentWaiters = new Map();        // Promesas esperando fragmentos
let ownPeerId = null;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
    const url = event.request.url;
    if (!url.includes('.m4s') && !url.includes('.mp4')) return;

    event.respondWith((async () => {
        const clients = await self.clients.matchAll({ includeUncontrolled: true });
        const cache = await caches.open(CACHE_NAME);

        // 1) Cache local
        const fromCache = await cache.match(event.request);
        if (fromCache) {
            clients.forEach(c =>
                c.postMessage({ type: 'fragment', url, source: 'cache' })
            );
            return fromCache;
        }

        // 2) Buscar peers que lo tienen
        const peersWith = [];
        for (const [peerId, urls] of peerInventory.entries()) {
            if (urls.has(url)) peersWith.push(peerId);
        }
        clients.forEach(c =>
            c.postMessage({
                type: 'log',
                message: `Peers con ${url}: ${peersWith.join(', ') || 'ninguno'}`
            })
        );

        // 3) Si hay peers, solicitamos y esperamos hasta 4 s
        if (peersWith.length > 0) {
            const peerId = peersWith[Math.floor(Math.random() * peersWith.length)];
            clients.forEach(c => {
                c.postMessage({ type: 'send-fragment-request', url: url, peerId: peerId });
                c.postMessage({
                    type: 'log',
                    message: `Solicitando ${url} a peer ${peerId}`
                });
            });

            const got = await waitFragment(url, 1250);
            if (got) {
                const fromPeerCache = await cache.match(event.request);

                //MÉTRICAS
                const buffer = await fromPeerCache.clone().arrayBuffer();
                await caches.open('fragment-logs').then(cache =>
                    cache.put(
                        new Request(`log-${Date.now()}-${Math.random().toString(36).slice(2)}`),
                        new Response(JSON.stringify({
                            peerId: ownPeerId,
                            url: url,
                            source: 'peer',         // cambia a 'http' si aplica
                            fromPeerId: peerId,   // o null si no aplica
                            bytes: buffer?.byteLength || 0,
                            timestamp: new Date().toISOString()
                        }), {
                            headers: { 'Content-Type': 'application/json' }
                        })
                    )
                );


                if (fromPeerCache) {
                    clients.forEach(c =>
                        c.postMessage({ type: 'fragment', url, source: 'peer' })
                    );
                    return fromPeerCache;
                }
            } else {
                clients.forEach(c =>
                    c.postMessage({
                        type: 'log',
                        message: `⏱️ Timeout de 4 s para ${url}, usando HTTP`
                    })
                );
            }
        }

        // 4) Fallback HTTP
        const resp = await fetch(event.request);
        if (resp.ok) {
            await cache.put(event.request, resp.clone());

            //MÉTRICAS
            const buffer = await resp.clone().arrayBuffer();
            await caches.open('fragment-logs').then(cache =>
                cache.put(
                    new Request(`log-${Date.now()}-${Math.random().toString(36).slice(2)}`),
                    new Response(JSON.stringify({
                        peerId: ownPeerId,
                        url: url,
                        source: 'http',
                        fromPeerId: '',
                        bytes: buffer?.byteLength || 0,
                        timestamp: new Date().toISOString()
                    }), {
                        headers: { 'Content-Type': 'application/json' }
                    })
                )
            );




            clients.forEach(c => {
                c.postMessage({ type: 'fragment', url, source: 'http' });
                c.postMessage({
                    type: 'log',
                    message: `Fragmento ${url} recuperado vía HTTP`
                });
            });
        }
        return resp;
    })());
});

self.addEventListener('message', async event => {
    const { type, peerId, urls, url, buffer } = event.data;
    const clients = await self.clients.matchAll({ includeUncontrolled: true });

    if (type === 'peer-inventory') {
        peerInventory.set(peerId, new Set(urls));
        clients.forEach(c =>
            c.postMessage({
                type: 'log',
                message: `Inventario de ${peerId}: ${urls.join(', ')}`
            })
        );
    }

    if (type === 'peer-disconnected') {
        peerInventory.delete(peerId);
        clients.forEach(c =>
            c.postMessage({
                type: 'log',
                message: `Peer desconectado: ${peerId}`
            })
        );
    }

    if (type === 'fragment-received') {

        const cache = await caches.open(CACHE_NAME);
        const exists = await cache.match(url);

        if (!exists) {
            const headers = new Headers({
                'Content-Type': 'application/octet-stream'
            });

            const response = new Response(buffer, { headers });
            await cache.put(url, response);
        }


        if (fragmentWaiters.has(url)) {
            fragmentWaiters.get(url)(true);
            fragmentWaiters.delete(url);
        }
    }

    if (type === 'set-own-peer-id') {
        ownPeerId = peerId;
        clients.forEach(c =>
            c.postMessage({
                type: 'log',
                message: `🔑 ID propio registrado en SW: ${peerId}`
            })
        );
    }


});

/**
 * Espera a 'fragment-received' o a que pasen 'timeout' ms.
 * Resuelve a true si llega el fragmento, a false si expira.
 */
function waitFragment(url, timeout = 4000) {
    return new Promise(resolve => {
        const timer = setTimeout(() => {
            fragmentWaiters.delete(url);
            resolve(false);
        }, timeout);

        fragmentWaiters.set(url, () => {
            clearTimeout(timer);
            resolve(true);
        });
    });
}
