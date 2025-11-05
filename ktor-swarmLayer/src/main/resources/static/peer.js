// ============================
// 📦 SERVICE WORKER SETUP
// ============================

async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) {
        console.warn('Service Worker no soportado');
        return null;
    }

    try {
        const registration = await navigator.serviceWorker.register('/sw.js');
        console.log('Service Worker registrado:', registration);

        // Esperar a que esté activo y controlando la página
        if (!navigator.serviceWorker.controller) {
            await new Promise(resolve => {
                navigator.serviceWorker.addEventListener('controllerchange', () => {
                    console.log('Service Worker ahora controla la página');
                    resolve();
                });
            });
        } else {
            await navigator.serviceWorker.ready;
        }

        return navigator.serviceWorker;
    } catch (err) {
        console.error('Error al registrar el Service Worker:', err);
        return null;
    }
}

// ============================
// ESCUCHA DE MENSAJES DEL SW
// ============================

navigator.serviceWorker?.addEventListener('message', (event) => {
    const data = event.data;

    if (data.type === 'send-fragment-request') {
        const req = new proto.fragmentRequest();
        req.setUrl(data.url);

        const wrapper = new proto.swarmLayerMessage();
        wrapper.setFragmentrequest(req);

        connections.get(data.peerId)?.conn.send(wrapper.serializeBinary());
    }

    if (data.type === 'send-inventory') {
        connections.forEach((peerData, peerId) => {
            const { conn } = peerData;
            const inv = new proto.inventory();
            inv.setUrlsList(Array.from(data.urls));

            const wrapper = new proto.swarmLayerMessage();
            wrapper.setInventory(inv);

            conn.send(wrapper.serializeBinary());
        });
    }
});

// ============================
// CONFIGURACIÓN DEL PEER
// ============================

const CACHE_NAME = 'video-fragments';
const connections = new Map();

const HEARTBEAT_INTERVAL = 15000;
const HEARTBEAT_TIMEOUT  = 20000;
const SERVER_KEEPALIVE_INTERVAL = 20000;

const peer = new Peer(undefined, {
    host: 'dashp2p.infinitebuffer.com',
    port: 443,
    path: '/peerjs',
    secure: true,
    config: {
        iceServers: [
            {
                urls: 'turn:dashp2p.infinitebuffer.com:3478?transport=udp',
                username: 'user1',
                credential: 'as9df7ng34nj'
            },
            { urls: 'stun:dashp2p.infinitebuffer.com:3478' }
        ],
        iceTransportPolicy: 'all'
    }
});

peer.on('error', err => console.error("PeerJS error:", err));

// ============================
// INICIALIZACIÓN
// ============================

(async () => {
    const sw = await registerServiceWorker();

    // Borrar caché cuando se recarga la página
    await caches.delete(CACHE_NAME);

    peer.on('open', async id => {
        console.log("Peer abierto con ID:", id);
        document.getElementById('my-id').innerText = id;

        // Asegurar que el SW está activo y controlar la página
        const controller = navigator.serviceWorker.controller || (await navigator.serviceWorker.ready).active;
        if (controller) {
            controller.postMessage({ type: 'peerId', peerId: id });
            console.log('📨 peerId enviado al Service Worker');
        } else {
            console.warn('⚠️ No se pudo enviar peerId: SW aún no controla la página');
        }

        await registerPeer(id);

        connectAllPeers();

        setInterval(() => sendKeepAlive(id), SERVER_KEEPALIVE_INTERVAL);

        // Heartbeat entre peers
        setInterval(() => {
            const now = Date.now();

            connections.forEach((peerData, peerId) => {
                const { conn, lastHeartbeat } = peerData;
                if (conn.open) {
                    const pingMsg = new proto.ping();
                    pingMsg.setSecnumber(1);
                    const wrapper = new proto.swarmLayerMessage();
                    wrapper.setPing(pingMsg);
                    conn.send(wrapper.serializeBinary());
                }

                if (now - lastHeartbeat > HEARTBEAT_TIMEOUT) {
                    console.warn('Peer no responde, cerrando conexión:', peerId);
                    conn.close();
                }
            });
        }, HEARTBEAT_INTERVAL);
    });

    peer.on('connection', conn => setupConnection(conn, conn.peer));
})();

// ============================
// FUNCIONES DE SERVIDOR
// ============================

function registerPeer(id) {
    return fetch('https://dashp2p.infinitebuffer.com/ktor/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
    }).then(res => res.json());
}

function sendKeepAlive(id) {
    fetch('https://dashp2p.infinitebuffer.com/ktor/keep-alive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
    }).catch(err => console.warn('Keep-alive failed:', err));
}

function connectAllPeers() {
    fetch('https://dashp2p.infinitebuffer.com/ktor/peers')
        .then(res => res.json())
        .then(data => {
            data.peers.forEach(peerId => {
                if (peerId !== peer.id && !connections.has(peerId)) {
                    const conn = peer.connect(peerId);
                    setupConnection(conn, peerId);
                }
            });
        });
}

// ============================
// SETUP DE CONEXIÓN PEER-PEER
// ============================

function setupConnection(conn, remoteId) {
    conn.on('open', async () => {
        console.log('Conectado a peer:', remoteId);
        connections.set(remoteId, { conn, lastHeartbeat: Date.now() });

        const cache = await caches.open(CACHE_NAME);
        const requests = await cache.keys();
        const localInventory = requests.map(req => req.url);

        const inv = new proto.inventory();
        inv.setUrlsList(Array.from(localInventory));

        const wrapper = new proto.swarmLayerMessage();
        wrapper.setInventory(inv);

        conn.send(wrapper.serializeBinary());

        conn.on('data', async data => {
            try {
                const msg = proto.swarmLayerMessage.deserializeBinary(data);
                const type = msg.getMsgCase();

                switch (type) {
                    case proto.swarmLayerMessage.MsgCase.PING: {
                        const ping = msg.getPing();
                        const pongMsg = new proto.pong();
                        pongMsg.setSecnumber(ping.getSecnumber());
                        const wrapper = new proto.swarmLayerMessage();
                        wrapper.setPong(pongMsg);
                        conn.send(wrapper.serializeBinary());
                        console.log('Recibido PING, enviado PONG a', remoteId);
                        break;
                    }

                    case proto.swarmLayerMessage.MsgCase.PONG: {
                        connections.get(remoteId).lastHeartbeat = Date.now();
                        console.log('PONG recibido de', remoteId);
                        break;
                    }

                    case proto.swarmLayerMessage.MsgCase.FRAGMENT: {
                        const frag = msg.getFragment();
                        const url = frag.getUrl();
                        const buffer = frag.getData_asU8();
                        navigator.serviceWorker.controller?.postMessage({
                            type: 'fragment-received',
                            buffer,
                            url
                        });
                        break;
                    }

                    case proto.swarmLayerMessage.MsgCase.INVENTORY: {
                        const urls = msg.getInventory().getUrlsList();
                        navigator.serviceWorker.controller?.postMessage({
                            type: 'peerInventory',
                            peerId: remoteId,
                            urls
                        });
                        break;
                    }

                    case proto.swarmLayerMessage.MsgCase.FRAGMENTREQUEST: {
                        const requestedUrl = msg.getFragmentrequest().getUrl();
                        const cache = await caches.open(CACHE_NAME);
                        const res = await cache.match(requestedUrl);
                        if (res) {
                            const buffer = await res.arrayBuffer();
                            const frag = new proto.fragment();
                            frag.setUrl(requestedUrl);
                            frag.setData(new Uint8Array(buffer));
                            const wrapper = new proto.swarmLayerMessage();
                            wrapper.setFragment(frag);
                            conn.send(wrapper.serializeBinary());
                        }
                        break;
                    }

                    default:
                        console.warn('Tipo de mensaje inválido:', type);
                        break;
                }
            } catch (err) {
                console.warn('Error al procesar mensaje:', err);
            }
        });
    });

    conn.on('close', () => {
        console.log('Peer desconectado:', remoteId);
        connections.delete(remoteId);
        navigator.serviceWorker.controller?.postMessage({
            type: 'peer-disconnected',
            peerId: remoteId
        });
    });
}
