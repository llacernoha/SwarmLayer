(function () {
    const PEERJS_URL = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
    const PROTOBUF_URL = 'https://unpkg.com/protobufjs/dist/protobuf.min.js';

    if (typeof protobuf === 'undefined') {
        const script = document.createElement('script');
        script.src = PROTOBUF_URL;
        script.onload = () => loadPeerJS();
        script.onerror = () => console.error('Error cargando protobuf.js');
        document.head.appendChild(script);
    } else {
        loadPeerJS();
    }

    function loadPeerJS() {
        if (typeof Peer === 'undefined') {
            const script = document.createElement('script');
            script.src = PEERJS_URL;
            script.onload = () => initP2P();
            script.onerror = () => console.error('Error cargando PeerJS');
            document.head.appendChild(script);
        } else {
            initP2P();
        }
    }


    function initP2P() {
        const protoRoot = protobuf.Root.fromJSON({
            nested: {
                FragmentMessage: {
                    fields: {
                        url: { type: "string", id: 1 },
                        buffer: { type: "bytes", id: 2 }
                    }
                }
            }
        });
        const FragmentMessage = protoRoot.lookupType("FragmentMessage");
        console.log('📦 Esquema Protobuf cargado: FragmentMessage listo');

        let peer;
        let keepAliveInterval;
        const connections = {};
        const localInventory = new Set();
        const peerInventory = {};
        const heartbeatIntervals = {};
        const heartbeatTimeouts = {};

        const registerUrl = 'https://dashp2p.infinitebuffer.com/ktor/register';
        const unRegisterUrl = 'https://dashp2p.infinitebuffer.com/ktor/unregister';
        const urlPeers = 'https://dashp2p.infinitebuffer.com/ktor/peers';
        const keepAliveUrl = 'https://dashp2p.infinitebuffer.com/ktor/keep-alive';
        window.peerInventory = peerInventory;
        window.localInventory = localInventory;


        function setupPeer(newPeer) {
            peer = newPeer;

            peer.on('open', id => {
                console.log('Peer abierto con ID:', id);
                const el = document.getElementById("my-id");
                if (el) el.innerText = id;

                registerPeer(id).then(() => connectAllPeers());

                // Keep-alive
                clearInterval(keepAliveInterval);
                keepAliveInterval = setInterval(() => {
                    if (peer.id && !peer.destroyed) {
                        sendKeepAlive(peer.id);
                    }
                }, 10000);
            });

            peer.on('connection', conn => setupConnection(conn, conn.peer));

            peer.on('disconnected', () => {
                console.warn('📴 Peer desconectado. Intentando reconectar...');
                unregisterPeer(peer.id);
                peer.reconnect();
            });

            peer.on('close', () => {
                console.warn('❌ Peer cerrado. Creando uno nuevo...');
                unregisterPeer(peer.id);
                clearInterval(keepAliveInterval);
                setupPeer(new Peer(getPeerConfig()));
            });
        }

        function getPeerConfig() {
            return {
                host: 'dashp2p.infinitebuffer.com',
                port: 443,
                path: '/peerjs',
                secure: true,
                config: {
                    iceServers: [
                        { urls: 'turn:dashp2p.infinitebuffer.com:3478?transport=udp', username: 'user1', credential: 'as9df7ng34nj' },
                        { urls: 'stun:dashp2p.infinitebuffer.com:3478' }
                    ],
                    iceTransportPolicy: 'all'
                }
            };
        }

        function startHeartbeat(conn, remoteId) {
            heartbeatIntervals[remoteId] = setInterval(() => {
                if (conn.open) {
                    conn.send({ type: 'ping' });

                    heartbeatTimeouts[remoteId] = setTimeout(() => {
                        conn.close();
                        delete connections[remoteId];
                        delete peerInventory[remoteId];
                        updatePeers();
                        clearInterval(heartbeatIntervals[remoteId]);
                    }, 10000);
                }
            }, 10000);

            conn.on('data', data => {
                if (data.type === 'ping') conn.send({ type: 'pong' });
                if (data.type === 'pong') clearTimeout(heartbeatTimeouts[remoteId]);
            });

            conn.on('close', () => {
                clearInterval(heartbeatIntervals[remoteId]);
                clearTimeout(heartbeatTimeouts[remoteId]);
                delete heartbeatIntervals[remoteId];
                delete heartbeatTimeouts[remoteId];
            });
        }

        function setupConnection(conn, remoteId) {
            conn.on('open', () => {
                connections[remoteId] = conn;
                updatePeers();
                startHeartbeat(conn, remoteId);
                conn.send({ type: 'inventory', urls: Array.from(localInventory) });



                conn.on('data', async data => {
                    if (data?.constructor?.name === 'Uint8Array' || data instanceof ArrayBuffer) {
                        try {
                            const decoded = FragmentMessage.decode(new Uint8Array(data));
                            console.log(`📥 Fragmento recibido de peer ${remoteId}`);
                            console.log(`🔓 Decodificado Protobuf: ${decoded.url} (${decoded.buffer.byteLength} bytes)`);
                            navigator.serviceWorker.controller?.postMessage({
                                type: 'fragment',
                                url: decoded.url,
                                buffer: decoded.buffer,
                                source: 'peer',
                                peerId: remoteId
                            });
                            localInventory.add(decoded.url);
                        } catch (err) {
                            console.warn("❌ Error al decodificar Protobuf:", err);
                        }
                    } else if (data.type === 'inventory') {
                        peerInventory[remoteId] = new Set(data.urls);
                    } else if (data.type === 'fragment-request') {
                        if (localInventory.has(data.url)) {
                            const cache = await caches.open('video-fragments');
                            const res = await cache.match(data.url);
                            if (res) {
                                const buffer = await res.arrayBuffer();
                                const encoded = FragmentMessage.encode({
                                    url: data.url,
                                    buffer: new Uint8Array(buffer)
                                }).finish();
                                conn.send(encoded);



                                //const buffer = await res.arrayBuffer();
                                //conn.send({ type: 'fragment', url: data.url, buffer });
                            }
                        }
                    }
                });
            });

            conn.on('close', () => {
                delete connections[remoteId];
                delete peerInventory[remoteId];
                updatePeers();
            });
        }

        function connectAllPeers() {
            fetch(urlPeers)
                .then(res => res.json())
                .then(data => {
                    const myId = peer.id;
                    data.peers.forEach(peerId => {
                        if (peerId !== myId && !connections[peerId]) {
                            const conn = peer.connect(peerId);
                            setupConnection(conn, peerId);
                        }
                    });
                });
        }

        function updatePeers() {
            const peers = Object.keys(connections);
            const total = peers.length;
            const shortIds = peers.map(id => id.slice(0, 6));
            const displayText = total
                ? `Peers conectados (${total}): ${shortIds.join(', ')}`
                : 'Peers conectados: ninguno';
            const el = document.getElementById("connected-peers");
            if (el) el.innerText = displayText;
        }

        function registerPeer(id) {
            return fetch(registerUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id })
            }).then(res => res.json());
        }

        function unregisterPeer(id) {
            return fetch(unRegisterUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id })
            }).catch(err => console.warn('❌ Unregister error:', err));
        }

        function sendKeepAlive(id) {
            fetch(keepAliveUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id })
            }).catch(err => console.warn('❌ Keep-alive failed:', err));
        }

        navigator.serviceWorker?.addEventListener('message', (event) => {
            const data = event.data;
            if (data.type === 'segment-requested') {
                const peersWithIt = Object.entries(peerInventory)
                    .filter(([_, urls]) => urls.has(data.url))
                    .map(([peerId]) => peerId);

                if (peersWithIt.length > 0) {
                    const randomPeer = peersWithIt[Math.floor(Math.random() * peersWithIt.length)];
                    const conn = connections[randomPeer];
                    if (conn?.open) {
                        conn.send({ type: 'fragment-request', url: data.url });
                    }
                } else {
                    navigator.serviceWorker.controller?.postMessage({
                        type: 'fragment-not-found',
                        url: data.url
                    });
                }
            }

            if (data.type === 'fragment') {
                localInventory.add(data.url);
                for (const peerId in connections) {
                    connections[peerId].send({
                        type: 'inventory',
                        urls: Array.from(localInventory)
                    });
                }
            }
        });



        // Comenzar
        setupPeer(new Peer(getPeerConfig()));




    }
})();
