(function () {
    const GOOGLE_PROTOBUF_URL = 'https://unpkg.com/google-protobuf@latest/google-protobuf.js';
    const SWARM_LAYER_PB_URL = 'https://dashp2p.infinitebuffer.com/ktor/swarmLayer_pb.js';
    const PEERJS_URL = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';

    // Paso 1: Cargar google-protobuf
    if (typeof jspb === 'undefined') {
        const script = document.createElement('script');
        script.src = GOOGLE_PROTOBUF_URL;
        script.onload = () => loadSwarmLayerPB();
        script.onerror = () => console.error('Error cargando google-protobuf.js');
        document.head.appendChild(script);
    } else {
        loadSwarmLayerPB();
    }

    // Paso 2: Cargar swarmLayer_pb.js
    function loadSwarmLayerPB() {
        if (typeof proto === 'undefined') {
            const script = document.createElement('script');
            script.src = SWARM_LAYER_PB_URL;
            script.onload = () => loadPeerJS();
            script.onerror = () => console.error('Error cargando swarmLayer_pb.js');
            document.head.appendChild(script);
        } else {
            loadPeerJS();
        }
    }

    // Paso 3: Cargar PeerJS
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


    async function initP2P() {
        if ('serviceWorker' in navigator) {
            const reg = await navigator.serviceWorker.register('/sw.js');
            if (!navigator.serviceWorker.controller) location.reload();
        }

        let peer;
        let keepAliveInterval;
        const connections = {};
        const localInventory = new Set();
        const heartbeatIntervals = {};
        const heartbeatTimeouts = {};

        const baseUrl = 'https://dashp2p.infinitebuffer.com/ktor';

        const registerUrl = `${baseUrl}/register`;
        const unRegisterUrl = `${baseUrl}/unregister`;
        const urlPeers = `${baseUrl}/peers`;
        const keepAliveUrl = `${baseUrl}/keep-alive`;



        window.localInventory = localInventory;


        function setupPeer(newPeer) {
            peer = newPeer;

            peer.on('open', id => {
                console.log('Peer abierto con ID:', id);
                const el = document.getElementById("my-id");
                if (el) el.innerText = id;

                // Enviar peerId al Service Worker
                if (navigator.serviceWorker.controller) {
                    navigator.serviceWorker.controller.postMessage({
                        type: 'set-own-peer-id',
                        peerId: id
                    });
                }

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
                console.warn('Peer cerrado. Creando uno nuevo...');
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
                        {
                            urls: 'turn:dashp2p.infinitebuffer.com:3478?transport=udp',
                            username: 'user1',
                            credential: 'as9df7ng34nj'
                        },
                        {urls: 'stun:dashp2p.infinitebuffer.com:3478'}
                    ],
                    iceTransportPolicy: 'all'
                }
            };
        }

        function startHeartbeat(conn, remoteId) {
            heartbeatIntervals[remoteId] = setInterval(() => {
                if (conn.open) {
                    ///
                    const pingMsg = new proto.ping();
                    pingMsg.setSecnumber(1);
                    const wrapper = new proto.swarmLayerMessage();
                    wrapper.setPing(pingMsg);
                    conn.send(wrapper.serializeBinary());
                    ///

                    heartbeatTimeouts[remoteId] = setTimeout(() => {
                        conn.close();
                        delete connections[remoteId];
                        navigator.serviceWorker.controller?.postMessage({
                            type: 'peer-disconnected',
                            peerId: remoteId
                        });

                        updatePeers();
                        clearInterval(heartbeatIntervals[remoteId]);
                    }, 10000);
                }
            }, 10000);

            conn.on('data', data => {
                try {
                    const msg = proto.swarmLayerMessage.deserializeBinary(data);
                    const type = msg.getMsgCase();

                    if (type === proto.swarmLayerMessage.MsgCase.PING) {
                        // Responder con PONG
                        const pongMsg = new proto.pong();
                        pongMsg.setSecnumber(msg.getPing().getSecnumber());

                        const wrapper = new proto.swarmLayerMessage();
                        wrapper.setPong(pongMsg);

                        conn.send(wrapper.serializeBinary());
                    }

                    if (type === proto.swarmLayerMessage.MsgCase.PONG) {
                        clearTimeout(heartbeatTimeouts[remoteId]);
                    }

                } catch (err) {
                }
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

                const inv = new proto.inventory();
                inv.setUrlsList(Array.from(localInventory)); // esto acepta un array de strings

                const wrapper = new proto.swarmLayerMessage();
                wrapper.setInventory(inv);

                conn.send(wrapper.serializeBinary());


                conn.on('data', async data => {
                    try {
                        const msg = proto.swarmLayerMessage.deserializeBinary(data);
                        const type = msg.getMsgCase();

                        if (type === proto.swarmLayerMessage.MsgCase.FRAGMENT) {
                            const frag = msg.getFragment();
                            const url = frag.getUrl();
                            const buffer = frag.getData_asU8();

                            navigator.serviceWorker.controller?.postMessage({
                                type: 'fragment-received',
                                url: url,
                                buffer: buffer
                            });
                        }


                        else if (type === proto.swarmLayerMessage.MsgCase.INVENTORY) {
                            const urls = msg.getInventory().getUrlsList();

                            navigator.serviceWorker.controller?.postMessage({
                                type: 'peer-inventory',
                                peerId: remoteId,
                                urls: urls
                            });

                        }

                        else if (type === proto.swarmLayerMessage.MsgCase.FRAGMENTREQUEST) {
                            const requestedUrl = msg.getFragmentrequest().getUrl();

                            if (localInventory.has(requestedUrl)) {
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
                            }
                        }

                        else if (type === proto.swarmLayerMessage.MsgCase.PING) {
                            const pingNum = msg.getPing().getSecnumber();

                            const pongMsg = new proto.pong();
                            pongMsg.setSecnumber(pingNum);

                            const response = new proto.swarmLayerMessage();
                            response.setPong(pongMsg);

                            conn.send(response.serializeBinary());
                        }

                        else if (type === proto.swarmLayerMessage.MsgCase.PONG) {
                            clearTimeout(heartbeatTimeouts[remoteId]);
                        }

                    } catch (err) {
                    }
                });
            });

            conn.on('close', () => {
                delete connections[remoteId];
                navigator.serviceWorker.controller?.postMessage({
                    type: 'peer-disconnected',
                    peerId: remoteId
                });

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
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({id})
            }).then(res => res.json());
        }

        function unregisterPeer(id) {
            return fetch(unRegisterUrl, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({id})
            }).catch(err => console.warn('Unregister error:', err));
        }

        function sendKeepAlive(id) {
            fetch(keepAliveUrl, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({id})
            }).catch(err => console.warn('Keep-alive failed:', err));
        }

        navigator.serviceWorker?.addEventListener('message', (event) => {
            const data = event.data;
            if (data.type === 'log') {
                console.log('log');
                console.log('[SW]', data.message);
            }

            if (data.type === 'debug-peer-inventory') {

                console.log('📦 Inventario de peers:', data.inventory);
            }

            if (data.type === 'send-fragment-request') {

                console.log('send-fragment-request');

                const req = new proto.fragmentRequest();
                req.setUrl(data.url);

                const wrapper = new proto.swarmLayerMessage();
                wrapper.setFragmentrequest(req);

                connections[data.peerId].send(wrapper.serializeBinary());
            }

            if (data.type === 'fragment') {
                localInventory.add(data.url);

                // Reenviar inventario actualizado a todos los peers
                for (const peerId in connections) {

                    const inv = new proto.inventory();
                    inv.setUrlsList(Array.from(localInventory));

                    const wrapper = new proto.swarmLayerMessage();
                    wrapper.setInventory(inv);

                    connections[peerId].send(wrapper.serializeBinary());
                }
            }
        });


        setupPeer(new Peer(getPeerConfig()));

    }
})();
