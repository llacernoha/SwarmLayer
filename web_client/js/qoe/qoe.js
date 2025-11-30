var player;
var controlbar;

var videoElement;
var eventsElement;
var resultsElement;

var newUrl;
var eventList = [];

var metricId;
var resultLoopId;

// QoE habilitado o no (por defecto DESHABILITADO)
var qoeEnabled = false;
var qoeToggleBtn;

// ----------------- Utilidades -----------------

function scrollToBottom() {
    eventsElement.scrollTop = eventsElement.scrollHeight;
}

function updateQoeToggleUI() {
    if (!qoeToggleBtn) return;

    if (qoeEnabled) {
        qoeToggleBtn.classList.remove('btn-outline-secondary');
        qoeToggleBtn.classList.add('btn-success');
        qoeToggleBtn.textContent = 'Enabled';
    } else {
        qoeToggleBtn.classList.remove('btn-success');
        qoeToggleBtn.classList.add('btn-outline-secondary');
        qoeToggleBtn.textContent = 'Disabled';
    }
}

// ----------------- Comunicación con servidor -----------------

function sendMetrics(metrics) {
    // Si QoE está deshabilitado, no se manda nada al servidor
    if (!qoeEnabled) {
        console.log("QoE deshabilitado: no se envían métricas al servidor.");
        return;
    }

    var metrics_data = {
        "mpd_url": newUrl,
        "metrics": metrics
    };

    fetch('/metrics', {
        method: 'POST',
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(metrics_data),
    })
    .then(response => {
        if (response.status === 200) {
            console.log("Processing media session events and data: ", response.status);
            response.json().then(data => metricId = data["metric_id"]);
        } else {
            console.log("Error sending metrics data to server: ", response.status);
        }
    })
    .catch(error => console.error('Error sending metrics data to server: ', error));
}

function getResult() {
    // Si está deshabilitado, no se pide resultado
    if (!qoeEnabled) return;

    if (!isNaN(metricId) && metricId >= 0) {
        fetch('/result', {
            method: 'POST',
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({"metric_id": metricId})
        })
        .then(response => {
            if (response.status === 200) {
                response.json().then(data => {
                    if (data["is_result_ready"]) {
                        console.log("Result ready: ", data["result"]);
                        clearInterval(resultLoopId);

                        var resultMOSElement = document.createElement("p");
                        resultMOSElement.innerHTML =
                            'Overall MOS result: ' + data.result["O46"] + '<br>' +
                            'Stalling quality: ' + data.result["O23"] + '<br>' +
                            'Audiovisual quality: ' + data.result["O35"];
                        resultsElement.appendChild(resultMOSElement);
                    }
                });
            } else {
                console.log("Error requesting MOS result to server: ", response.status);
            }
        });
    }
}

// ----------------- Gestión de eventos dash.js -----------------

function processEvent(e) {
    console.log(e);
    var eventObject;
    var htmlString;
    var eventElement;

    switch (e.type) {
        case dashjs.MediaPlayer.events.BUFFER_EMPTY:
            if (e.mediaType === "video") {
                eventObject = {
                    type: "stall_ini",
                    clock_time: Date.now(),
                    media_time: player.time()
                };
                htmlString = "Stalling started.";
                eventElement = document.createElement("div");
                eventElement.className = "alert alert-danger";
                eventElement.role = "alert";
                eventElement.innerHTML = htmlString;
                eventsElement.appendChild(eventElement);
            }
            break;

        case dashjs.MediaPlayer.events.BUFFER_LOADED:
            if (e.mediaType === "video") {
                eventObject = {
                    type: "stall_end",
                    clock_time: Date.now(),
                    media_time: player.time()
                };
                htmlString = "Stalling ended.";
                eventElement = document.createElement("div");
                eventElement.className = "alert alert-secondary";
                eventElement.role = "alert";
                eventElement.innerHTML = htmlString;
                eventsElement.appendChild(eventElement);
            }
            break;

        case dashjs.MediaPlayer.events.QUALITY_CHANGE_RENDERED:
            if (e.mediaType === "video") {
                eventObject = {
                    type: "quality_change",
                    clock_time: Date.now(),
                    media_time: player.time(),
                    current_rep_id: e.newRepresentation.id
                };
                htmlString = "Quality changed to " + e.newRepresentation.id;
                eventElement = document.createElement("div");
                eventElement.className = "alert alert-warning";
                eventElement.role = "alert";
                eventElement.innerHTML = htmlString;
                eventsElement.appendChild(eventElement);
            }
            break;

        case dashjs.MediaPlayer.events.STREAM_INITIALIZED:
            eventObject = {
                type: "playback_started",
                clock_time: Date.now(),
                media_time: player.time(),
                current_rep_id: player.getActiveStream().getCurrentRepresentationForType("video").id
            };
            htmlString = "Playback started.";
            eventElement = document.createElement("div");
            eventElement.className = "alert alert-info";
            eventElement.role = "alert";
            eventElement.innerHTML = htmlString;
            eventsElement.appendChild(eventElement);
            break;

        case dashjs.MediaPlayer.events.PLAYBACK_ENDED:
            eventObject = {
                type: "playback_ended",
                clock_time: Date.now(),
                media_time: player.time()
            };
            htmlString = "Playback ended." + (qoeEnabled ? " Starting MOS extraction." : "");
            eventElement = document.createElement("div");
            eventElement.className = "alert alert-info";
            eventElement.id = "playback-end-message";
            eventElement.role = "alert";
            eventElement.innerHTML = htmlString;
            eventsElement.appendChild(eventElement);

            scrollToBottom();

            eventList.push(eventObject);

            // Solo enviar métricas y pedir resultados si está habilitado
            if (qoeEnabled) {
                sendMetrics(eventList);
                eventList = []; // Reset event list when video is changed
                resultLoopId = setInterval(getResult, 3000);
            }

            return null;
    }

    if (eventObject) {
        eventList.push(eventObject);
    }
    scrollToBottom();
    return null;
}

// ----------------- Inicialización del player QoE -----------------

function init(url) {
    // usamos el vídeo compartido de SwarmLayer
    videoElement = document.querySelector('#video-sl');
    player = dashjs.MediaPlayer().create();

    player.initialize(videoElement, url, false);
    controlbar = new ControlBar(player);
    controlbar.initialize();

    // eventos del reproductor
    player.on(dashjs.MediaPlayer.events.BUFFER_EMPTY, processEvent);
    player.on(dashjs.MediaPlayer.events.QUALITY_CHANGE_RENDERED, processEvent);
    player.on(dashjs.MediaPlayer.events.BUFFER_LOADED, processEvent);
    player.on(dashjs.MediaPlayer.events.PLAYBACK_ENDED, processEvent);
    player.on(dashjs.MediaPlayer.events.STREAM_INITIALIZED, processEvent);
}

// ----------------- Cambiar de vídeo (llamado por SwarmLayer) -----------------

function changeVideo() {

    clearInterval(resultLoopId);

    eventsElement.innerHTML = '';
    resultsElement.innerHTML = '';

    // MPD controlada globalmente por SwarmLayer
    newUrl = window.mpd;

    // Primera vez: creamos el player y cargamos source
    if (!player) {
        init(newUrl);
    } else {
        player.attachSource(newUrl);
    }

    // Solo notificar al servidor el nuevo MPD si QoE está habilitado
    if (qoeEnabled) {
        var mpd_data = {"mpd_url": newUrl};

        fetch('/mpd', {
            method: 'POST',
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(mpd_data),
        })
        .then(response => {
            if (response.status === 200) {
                console.log("Processing new MPD in server: ", response.status);
            } else {
                console.log("Error sending MPD to server: ", response.status);
            }
        })
        .catch(error => console.error('Error sending MPD to server: ', error));
    } else {
        console.log("QoE deshabilitado: no se envía MPD al servidor.");
    }
}

// ----------------- DOMContentLoaded -----------------

document.addEventListener('DOMContentLoaded', function () {
    eventsElement  = document.querySelector('.events');
    resultsElement = document.querySelector('.results');

    // Botón toggle QoE
    qoeToggleBtn = document.getElementById('qoe-toggle-btn');
    if (qoeToggleBtn) {
        updateQoeToggleUI();

        qoeToggleBtn.addEventListener('click', function () {
            qoeEnabled = !qoeEnabled;

            // si lo deshabilitamos, paramos cualquier polling de resultados
            if (!qoeEnabled && resultLoopId) {
                clearInterval(resultLoopId);
                resultLoopId = null;
            }

            updateQoeToggleUI();
        });
    }
});
