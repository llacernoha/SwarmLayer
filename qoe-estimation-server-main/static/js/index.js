var player
var controlbar

var videoElement
var videoDivElement
var textBarElement
var sendButtonElement
var eventsElement
var resultsElement

var newUrl
var eventList = []

var metricId
var resultLoopId

function scrollToBottom() {
    eventsElement.scrollTop = eventsElement.scrollHeight;
}

function sendMetrics(metrics) {
    var metrics_data = {
        "mpd_url": newUrl,
        "metrics": metrics
    }

    fetch('/metrics', {
        method: 'POST',
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(metrics_data),
    })
    .then(response => {
        if (response.status === 200) {
            console.log("Processing media session events and data: ", response.status)
            response.json().then(data => metricId = data["metric_id"])
        } else {
            console.log("Error sending metrics data to server: ", response.status)
        }
    })
    .catch(error => console.error('Error sending metrics data to server: ', error));
}

function getResult() {
    if (!isNaN(metricId) && metricId >= 0) {
        fetch('/result', {
            method: 'POST',
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({"metric_id": metricId})
        })
        .then(response => {
            if (response.status === 200) {
                response.json().then(data => {
                    if(data["is_result_ready"]) {
                        console.log("Result ready: ", data["result"])
                        clearInterval(resultLoopId)
                        // window.alert("MOS result: " + data.result)
                        var resultMOSElement = document.createElement("p")
                        resultMOSElement.innerHTML =
                            'Overall MOS result: ' + data.result["O46"] + '<br>' +
                            'Stalling quality: ' + data.result["O23"] + '<br>' +
                            'Audiovisual quality: ' + data.result["O35"]
                        resultsElement.appendChild(resultMOSElement)
                    }
                })
            } else {
                console.log("Error requesting MOS result to server: ", response.status)
            }
        })
    }
}

function processEvent(e) {
    console.log(e)
    var eventObject
    var htmlString
    var eventElement
    switch (e.type) {
        case dashjs.MediaPlayer.events.BUFFER_EMPTY:
            if (e.mediaType === "video") {
                eventObject = {
                    type: "stall_ini",
                    clock_time: Date.now(),
                    media_time: player.time()
                }
                htmlString = "Stalling started."
                eventElement = document.createElement("div")
                eventElement.className = "alert alert-danger"
                eventElement.role = "alert"
                eventElement.innerHTML = htmlString
                eventsElement.appendChild(eventElement)
            }
            break;
        case dashjs.MediaPlayer.events.BUFFER_LOADED:
            if (e.mediaType === "video") {
                eventObject = {
                    type: "stall_end",
                    clock_time: Date.now(),
                    media_time: player.time()
                }
                htmlString = "Stalling ended."
                eventElement = document.createElement("div")
                eventElement.className = "alert alert-secondary"
                eventElement.role = "alert"
                eventElement.innerHTML = htmlString
                eventsElement.appendChild(eventElement)
            }
            break;
        case dashjs.MediaPlayer.events.QUALITY_CHANGE_RENDERED:
            if (e.mediaType === "video") {
                eventObject = {
                    type: "quality_change",
                    clock_time: Date.now(),
                    media_time: player.time(),
                    current_rep_id: e.newRepresentation.id
                }
                htmlString = "Quality changed to " + e.newRepresentation.id
                eventElement = document.createElement("div")
                eventElement.className = "alert alert-warning"
                eventElement.role = "alert"
                eventElement.innerHTML = htmlString
                eventsElement.appendChild(eventElement)
            }
            break;
        case dashjs.MediaPlayer.events.STREAM_INITIALIZED:
            eventObject = {
                type: "playback_started",
                clock_time: Date.now(),
                media_time: player.time(),
                current_rep_id: player.getActiveStream().getCurrentRepresentationForType("video").id
            }
            htmlString = "Playback started."
            eventElement = document.createElement("div")
            eventElement.className = "alert alert-info"
            eventElement.role = "alert"
            eventElement.innerHTML = htmlString
            eventsElement.appendChild(eventElement)
            break;
        case dashjs.MediaPlayer.events.PLAYBACK_ENDED:
            eventObject = {
                type: "playback_ended",
                clock_time: Date.now(),
                media_time: player.time()
            }
            htmlString = "Playback ended. Starting MOS extraction."
            eventElement = document.createElement("div")
            eventElement.className = "alert alert-info"
            eventElement.id = "playback-end-message"
            eventElement.role = "alert"
            eventElement.innerHTML = htmlString
            eventsElement.appendChild(eventElement)

            scrollToBottom()

            eventList.push(eventObject)
            sendMetrics(eventList)
            eventList = [] // Reset event list when video is changed

            // Begin trying to get the MOS result
            resultLoopId = setInterval(getResult, 3000)
            return null;
    }
    if (eventObject) {
        eventList.push(eventObject)
    }
    scrollToBottom()
    return null
}

function init(url) {
    videoElement = document.querySelector('.videoContainer video');
    player = dashjs.MediaPlayer().create();

    player.initialize(videoElement, url, false);
    controlbar = new ControlBar(player);
    controlbar.initialize();

    // enter default url in text bar
    textBarElement.setAttribute("value", url)

    // manage player events
    player.on(dashjs.MediaPlayer.events.BUFFER_EMPTY, processEvent);
    player.on(dashjs.MediaPlayer.events.QUALITY_CHANGE_RENDERED, processEvent);
    player.on(dashjs.MediaPlayer.events.BUFFER_LOADED, processEvent);
    player.on(dashjs.MediaPlayer.events.PLAYBACK_ENDED, processEvent);
    player.on(dashjs.MediaPlayer.events.STREAM_INITIALIZED, processEvent);
}

function changeVideo() {

    clearInterval(resultLoopId)

    eventsElement.innerHTML = ''
    resultsElement.innerHTML = ''

    newUrl = textBarElement.value

    if (videoDivElement.style.visibility === "hidden") {
        videoDivElement.style.visibility = "visible"
        init(newUrl)
    } else {
        player.attachSource(newUrl)
    }

    // Send message with MPD to server

    var mpd_data = {"mpd_url": newUrl}

    fetch('/mpd', {
        method: 'POST',
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mpd_data),
    })
    .then(response => {
        if (response.status === 200) {
            console.log("Processing new MPD in server: ", response.status)
        } else {
            console.log("Error sending MPD to server: ", response.status)
        }
    })
    .catch(error => console.error('Error sending MPD to server: ', error));
}

document.addEventListener('DOMContentLoaded', function () {
    textBarElement = document.querySelector('#mpd-input');
    videoDivElement = document.querySelector(".dash-video-player")
    eventsElement = document.querySelector('.events');
    resultsElement = document.querySelector(".results");

    // set behavior of the button
    sendButtonElement = document.querySelector(".input-url button");
    sendButtonElement.onclick = changeVideo
});