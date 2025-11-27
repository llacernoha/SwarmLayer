package comm

import io.ktor.http.*
import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.application.*
import io.ktor.server.plugins.contentnegotiation.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.server.http.content.*
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.encodeToJsonElement
import java.io.File
import java.io.Writer
import java.util.Collections
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

// -------- ESTADO DE GRUPOS --------
//
// Los grupos se definen por (mpd, groupId) enviados por el peer.
//
// groupState = {
//   GroupKey(mpd="...", groupId="1") : [PeerEntry, PeerEntry],
//   GroupKey(mpd="...", groupId="2") : [...],
//   ...
// }
//
data class PeerEntry(val id: String, val timestamp: Long)

data class GroupKey(val mpd: String, val groupId: String)

val groupState = mutableMapOf<GroupKey, MutableList<PeerEntry>>()
val groupLock = ReentrantLock()


// ----------------------------
// MÉTRICAS
// ----------------------------

private val jsonPretty = Json { prettyPrint = true; encodeDefaults = true }
private val jsonCompact = Json { prettyPrint = false; encodeDefaults = true }

private val metricsFile = File("metricas.json")
private val metricsLock = ReentrantLock()


// ----------------------------
// DTOs
// ----------------------------

@Serializable
data class PeerInfoRequest(
    val id: String,
    val mpd: String,
    val group: String
)

@Serializable
data class MetricData(
    val fragmentUrl: String,
    val source: String,
    val sender: String? = null,
    val receiver: String,
    val time: Long,
    val sizeBytes: Long,
    val peersWith: List<String> = emptyList(),
    val peersWithFragments: List<String> = emptyList(),
    val type: String? = null,
    val groupId: String? = null
)


// ======================================================================
// APPLICATION MODULE
// ======================================================================

fun Application.module() {

    install(ContentNegotiation) { json() }

    println("<<< SERVIDOR SWARMLAYER INICIADO >>>")

    // limpieza periódica por timeout usando timestamps de PeerEntry
    launch {
        while (true) {
            purgeDeadPeers()
            delay(10_000)
        }
    }

    val sseClients = Collections.synchronizedSet(mutableSetOf<Writer>())

    fun readAllMetrics(): List<MetricData> = metricsLock.withLock {
        if (!metricsFile.exists()) return emptyList()
        val raw = metricsFile.readText()
        if (raw.isBlank()) emptyList()
        else runCatching { jsonPretty.decodeFromString<List<MetricData>>(raw) }.getOrElse { emptyList() }
    }

    // =============================================================
    // RUTAS
    // =============================================================

    routing {

        // Archivos estáticos
        staticResources("/", "static")
        staticResources("/hero", "hero")
        staticResources("/sprite", "sprite")

        // =========================================================
        // --------------        /set-info        -------------------
        // =========================================================
        post("/set-info") {
            val req = call.receive<PeerInfoRequest>()
            val now = System.currentTimeMillis()

            val key = GroupKey(mpd = req.mpd, groupId = req.group)

            val peersInGroup: List<String> = groupLock.withLock {
                // 1) eliminar al peer de cualquier grupo anterior (mpd/grupo antiguos)
                removePeerFromAllGroupsUnsafe(req.id)

                // 2) obtener o crear el grupo para esta tupla (mpd, group)
                val list = groupState.getOrPut(key) { mutableListOf() }

                // 3) añadir o actualizar este peer en el grupo
                list.removeIf { it.id == req.id }
                list.add(PeerEntry(req.id, now))

                // 4) devolver lista de peers del grupo
                list.map { it.id }
            }

            println("SET-INFO >>> Peer=${req.id}, mpd=${req.mpd}, group=${req.group}, Peers=$peersInGroup")

            call.respond(peersInGroup)
        }

        // =========================================================
        //                        MÉTRICAS
        // =========================================================

        get("/metrics") {
            val minutes = call.request.queryParameters["minutes"]?.toLongOrNull() ?: 5
            if (minutes <= 0) {
                call.respond(HttpStatusCode.BadRequest, "minutes debe ser > 0")
                return@get
            }

            val now = System.currentTimeMillis()
            val from = now - minutes * 60_000

            val recent = readAllMetrics()
                .filter { it.time in from..now }
                .sortedBy { it.time }

            val totalBytes = recent.sumOf { it.sizeBytes }
            val itemsJson = jsonPretty.encodeToJsonElement(recent)

            val payload = buildJsonObject {
                put("from", from)
                put("to", now)
                put("minutes", minutes)
                put("count", recent.size)
                put("totalBytes", totalBytes)
                put("items", itemsJson)
            }

            call.respond(payload)
        }

        get("/metrics/live") {
            call.response.cacheControl(CacheControl.NoCache(null))
            call.respondTextWriter(contentType = ContentType.Text.EventStream) {
                synchronized(sseClients) { sseClients += this }
                println("SSE conectado (${sseClients.size})")
                try {
                    while (true) {
                        write(": keepalive\n\n")
                        flush()
                        delay(15_000)
                    }
                } finally {
                    synchronized(sseClients) { sseClients -= this }
                    println("SSE desconectado (${sseClients.size})")
                }
            }
        }

        post("/metric") {
            val metric = call.receive<MetricData>()

            // 1) localizar al peer receiver en la estructura de grupos
            val (peerMpd, peerGroupId) = groupLock.withLock {
                findPeerLocationUnsafe(metric.receiver) ?: ("unknown" to "unknown")
            }

            val src = metric.source.lowercase()

            // 2) normalizar + añadir "type"=mpd y groupId
            val normalized = metric.copy(
                source = src,
                sender = if (src == "http") null else metric.sender,
                type = peerMpd,
                groupId = peerGroupId
            )

            // 3) guardar en metricas.json
            metricsLock.withLock {
                val updated = readAllMetrics() + normalized
                val tmp = File(metricsFile.parentFile ?: File("."), metricsFile.name + ".tmp")
                tmp.writeText(jsonPretty.encodeToString(updated))
                if (!tmp.renameTo(metricsFile)) {
                    metricsFile.writeText(tmp.readText())
                    tmp.delete()
                }
            }

            // 4) enviar por SSE
            val compact = jsonCompact.encodeToString(normalized)
            val payload = buildString {
                append("event: metric\n")
                compact.split('\n').forEach { line ->
                    append("data: ").append(line).append('\n')
                }
                append('\n')
            }

            val muertos = mutableListOf<Writer>()
            synchronized(sseClients) {
                sseClients.forEach { w ->
                    runCatching {
                        w.write(payload)
                        w.flush()
                    }.onFailure { muertos += w }
                }
                sseClients.removeAll(muertos.toSet())
            }

            call.respond(mapOf("ok" to true))
        }
    }
}

/**
 * Buscar dónde está un peer: devuelve (mpd, groupId) o null.
 * IMPORTANTE: llamar solo dentro de groupLock.withLock.
 */
fun findPeerLocationUnsafe(peerId: String): Pair<String, String>? {
    for ((key, list) in groupState) {
        if (list.any { it.id == peerId }) {
            return key.mpd to key.groupId
        }
    }
    return null
}

/** Elimina un peer de cualquier grupo en el que esté. */
fun removePeerFromAllGroupsUnsafe(peerId: String) {
    val emptyKeys = mutableListOf<GroupKey>()

    groupState.forEach { (key, list) ->
        list.removeIf { it.id == peerId }
        if (list.isEmpty()) {
            emptyKeys.add(key)
        }
    }

    emptyKeys.forEach { key -> groupState.remove(key) }
}

/** Limpia peers por timeout y borra grupos vacíos. */
fun purgeDeadPeers() {
    val now = System.currentTimeMillis()
    val timeout = 20_000L

    groupLock.withLock {
        val emptyKeys = mutableListOf<GroupKey>()

        groupState.forEach { (key, list) ->
            list.removeIf { now - it.timestamp > timeout }
            if (list.isEmpty()) {
                emptyKeys.add(key)
            }
        }

        emptyKeys.forEach { key ->
            groupState.remove(key)
        }
    }
}
