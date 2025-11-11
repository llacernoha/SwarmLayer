clearCache()
// Cargar Service Worker
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js');
}

// Variables globales
const connections = new Map();
var peer_id = null;

const HEARTBEAT_INTERVAL = 15000;
const HEARTBEAT_TIMEOUT = 20000;
const SERVER_KEEPALIVE_INTERVAL = 20000;

// Instanciación PeerJS
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

// Peer conectado
peer.on('open', async id => {
    peer_id = id;
    console.log("Peer abierto con ID:", id);
    document.getElementById('my-id').innerText = id;


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


// Funciones servidor
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

// Setup peer-peer
function setupConnection(conn, remoteId) {
    conn.on('open', async () => {
        console.log('Conectado a peer:', remoteId);
        connections.set(remoteId, { conn, lastHeartbeat: Date.now() });

        // Enviamos el localInventory al peer que acaba de conectarse
        const localInventory = await getLocalInventory();

        const inv = new proto.inventory();
        inv.setUrlsList(Array.from(localInventory));

        const wrapper = new proto.swarmLayerMessage();
        wrapper.setInventory(inv);

        conn.send(wrapper.serializeBinary());

        // Si se reciben datos por dataChannel:
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
                        break;
                    }

                    case proto.swarmLayerMessage.MsgCase.PONG: {
                        connections.get(remoteId).lastHeartbeat = Date.now();
                        break;
                    }

                    case proto.swarmLayerMessage.MsgCase.FRAGMENT: {
                        const frag = msg.getFragment();
                        const url = frag.getUrl();
                        const buffer = frag.getData_asU8();
                        const size = buffer.byteLength;

                        const cache = await caches.open('video-fragments');
                        await cache.put(url, new Response(buffer, { headers: { 'Content-Type': 'application/octet-stream' } }));

                        navigator.serviceWorker.controller?.postMessage({ type: 'p2p-fragment-received', url });
                        console.log(`${url}, p2p, ${remoteId}, ${peer_id}, ${Date.now()}, ${size}`);

                        await sendMetric({
                            fragmentUrl: url,
                            source: 'p2p',
                            sender: remoteId,
                            receiver: peer_id,
                            time: Date.now(),
                            sizeBytes: size
                        });

                        break;
                    }

                    case proto.swarmLayerMessage.MsgCase.INVENTORY: {
                        const urls = msg.getInventory().getUrlsList();
                        navigator.serviceWorker.controller?.postMessage({ type: 'peerInventory', peerId: remoteId, urls });
                        break;
                    }

                    case proto.swarmLayerMessage.MsgCase.FRAGMENTREQUEST: {
                        const requestedUrl = msg.getFragmentrequest().getUrl();
                        const cache = await caches.open('video-fragments');
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
                        //
                        break;
                }
            } catch (err) {
                //
            }
        });
    });

    conn.on('close', () => {
        connections.delete(remoteId);
        navigator.serviceWorker.controller?.postMessage({ type: 'peer-disconnected', peerId: remoteId });
    });
}

// Obtener urls en caché
async function getLocalInventory() {
    const cache = await caches.open('video-fragments');
    const requests = await cache.keys();
    return requests.map(req => req.url);
}

// Borrar cache
async function clearCache() {
    await caches.delete('video-fragments');
    console.log('Caché borrada correctamente');
}

// Enviar métricas al servidor
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

// Escuchar mensajes del sw.js
navigator.serviceWorker?.addEventListener('message', async (event) => {
    const data = event.data;

    switch (data.type) {

        case 'p2p-fragment-request':
            // Solicitar fragmento al peer correspondiente
            const req = new proto.fragmentRequest();
            req.setUrl(data.url);

            const wrapper = new proto.swarmLayerMessage();
            wrapper.setFragmentrequest(req);

            connections.get(data.peerId)?.conn.send(wrapper.serializeBinary());
            //console.log(`Fragmento p2p solicitado a: ${data.peerId} con url: ${data.url}`);


            break;
        case 'http-fragment-received':
            //console.log(`Fragmento http recibido: ${data.url}, tamaño: ${data.size}`);
            // Enviar localInventory a los demás peers
            const localInventory = await getLocalInventory();

            const inv = new proto.inventory();
            inv.setUrlsList(Array.from(localInventory));
            const wrap = new proto.swarmLayerMessage();
            wrap.setInventory(inv);
            const bin = wrap.serializeBinary();

            for (const value of connections.values()) {
                value.conn.send(bin);
            }
            console.log(`${data.url}, http, , ${peer_id}, ${Date.now()}, ${data.size}`);

            await sendMetric({
                fragmentUrl: data.url,
                source: 'http',
                sender: '',
                receiver: peer_id,
                time: Date.now(),
                sizeBytes: data.size
            });

            break;
    }

});
