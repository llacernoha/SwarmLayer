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

// -------- CONFIGURACIÓN DE GRUPOS --------

@Serializable
data class GroupConfig(val mpds: List<String>, val maxNodes: Int)

// se carga desde group-config.json
lateinit var groupConfig: Map<String, GroupConfig>

// -------- ESTADO DE GRUPOS --------

data class PeerEntry(val id: String, val timestamp: Long)

/*
groupState = {
  "0" : {
      "00": [PeerEntry, PeerEntry],
      "01": [...]
  },
  "1" : {...}
}
*/
val groupState = mutableMapOf<String, MutableMap<String, MutableList<PeerEntry>>>()
val groupLock = ReentrantLock()


// ----------------------------
// MÉTRICAS
// ----------------------------

private val jsonPretty = Json { prettyPrint = true; encodeDefaults = true }
private val jsonCompact = Json { prettyPrint = false; encodeDefaults = true }

private val metricsFile = File("metricas.json")
private val metricsLock = ReentrantLock()


// ----------------------------
// DTO de entrada
// ----------------------------

@Serializable
data class PeerInfoRequest(val id: String, val mpd: String)

@Serializable
data class MetricData(
    val fragmentUrl: String,
    val source: String,   // "p2p" o "http"
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

    // cargar configuración de grupos desde group-config.json (mismo directorio que el .jar)
    val cfgFile = File("group-config.json")
    if (!cfgFile.exists()) error("NO existe group-config.json en el directorio del servidor")

    groupConfig = Json.decodeFromString(cfgFile.readText())

    println("<<< CONFIGURACIÓN DE GRUPOS CARGADA >>>")
    println(jsonPretty.encodeToString(groupConfig))

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

            // 1) type según MPD
            val targetType = findTypeForMpd(req.mpd)
            if (targetType == null) {
                call.respond(HttpStatusCode.BadRequest, "MPD no soportada")
                return@post
            }

            val (finalType, finalGroupId, peersInGroup) = groupLock.withLock {
                // ¿Existe ya la id en algún grupo?
                val currentLoc = findPeerLocationUnsafe(req.id)

                if (currentLoc == null) {
                    // CASO A: peer NUEVO -> ubicar donde haga falta
                    val gid = assignPeerToTypeUnsafe(req.id, targetType, now)
                    val peers = groupState[targetType]!![gid]!!.map { it.id }
                    Triple(targetType, gid, peers)
                } else {
                    val (currentType, currentGroupId) = currentLoc

                    if (currentType == targetType) {
                        // CASO B: la id existe y sigue en el type que debe -> NO mover, solo actualizar timestamp
                        val list = groupState[currentType]!![currentGroupId]!!
                        val idx = list.indexOfFirst { it.id == req.id }
                        if (idx >= 0) {
                            list[idx] = list[idx].copy(timestamp = now)
                        }
                        val peers = list.map { it.id }
                        Triple(currentType, currentGroupId, peers)
                    } else {
                        // CASO C: la id existe pero NO está en el type correcto
                        // 1) eliminar del sitio donde estaba
                        val oldGroups = groupState[currentType]!!
                        val oldList = oldGroups[currentGroupId]!!
                        oldList.removeIf { it.id == req.id }
                        if (oldList.isEmpty()) {
                            oldGroups.remove(currentGroupId)
                            if (oldGroups.isEmpty()) {
                                groupState.remove(currentType)
                            }
                        }

                        // 2) reubicar en el type que debe, sin tocar otras ids
                        val gid = assignPeerToTypeUnsafe(req.id, targetType, now)
                        val peers = groupState[targetType]!![gid]!!.map { it.id }
                        Triple(targetType, gid, peers)
                    }
                }
            }

            println("SET-INFO >>> Peer=${req.id}, Type=$finalType, Group=$finalGroupId, Peers=$peersInGroup")

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
            val (peerType, peerGroupId) = groupLock.withLock {
                // findPeerLocationUnsafe devuelve Pair(type, groupId) o null
                findPeerLocationUnsafe(metric.receiver) ?: ("unknown" to "unknown")
            }

            val src = metric.source.lowercase()

            // 2) normalizar + añadir type y groupId
            val normalized = metric.copy(
                source = src,
                sender = if (src == "http") null else metric.sender,
                type = peerType,
                groupId = peerGroupId
            )

            // 3) guardar en metricas.json como antes
            metricsLock.withLock {
                val updated = readAllMetrics() + normalized
                val tmp = File(metricsFile.parentFile ?: File("."), metricsFile.name + ".tmp")
                tmp.writeText(jsonPretty.encodeToString(updated))
                if (!tmp.renameTo(metricsFile)) {
                    metricsFile.writeText(tmp.readText())
                    tmp.delete()
                }
            }

            // 4) enviar por SSE igual que antes
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



fun findTypeForMpd(mpd: String): String? {
    return groupConfig.entries.firstOrNull { (_, cfg) ->
        mpd in cfg.mpds
    }?.key
}

/** Buscar dónde está un peer: devuelve (type, groupId) o null.
 *  IMPORTANTE: llamar solo dentro de groupLock.withLock.
 */
fun findPeerLocationUnsafe(peerId: String): Pair<String, String>? {
    for ((type, groups) in groupState) {
        for ((groupId, list) in groups) {
            if (list.any { it.id == peerId }) {
                return type to groupId
            }
        }
    }
    return null
}

private fun suffixIndex(groupId: String, type: String): Int {
    return groupId.removePrefix(type).toIntOrNull() ?: Int.MAX_VALUE
}

/**
 * Mete un peer en el type indicado:
 * - Busca grupo de ese type con hueco, empezando por el de menor número
 * - Si no hay, crea grupo nuevo con el menor índice libre:
 *      type=0 -> 00, 01, 02...
 *      type=1 -> 10, 11, 12...
 * Se asume que se llama dentro de groupLock.withLock.
 * Devuelve el groupId donde ha quedado.
 */
fun assignPeerToTypeUnsafe(peerId: String, type: String, now: Long): String {
    val cfg = groupConfig[type] ?: error("No hay configuración para type=$type")

    val typeGroups = groupState.getOrPut(type) { mutableMapOf() }

    // 1) buscar grupo con hueco, ordenado por índice (00,01,02... / 10,11,12...)
    val sortedGroupIds = typeGroups.keys.sortedBy { suffixIndex(it, type) }
    for (gid in sortedGroupIds) {
        val peers = typeGroups[gid]!!
        if (peers.size < cfg.maxNodes) {
            // por si ya estaba, lo quitamos y lo volvemos a meter con timestamp nuevo
            peers.removeIf { it.id == peerId }
            peers.add(PeerEntry(peerId, now))
            return gid
        }
    }

    // 2) no hay grupos con hueco -> crear grupo nuevo con el menor índice libre
    val usedIndices = typeGroups.keys
        .mapNotNull { suffixIndex(it, type).takeIf { idx -> idx != Int.MAX_VALUE } }
        .toMutableSet()

    var idx = 0
    while (idx in usedIndices) idx++

    val newGroupId = type + idx.toString()   // "0"+"0" = "00", "1"+"0"="10", etc.
    typeGroups[newGroupId] = mutableListOf(PeerEntry(peerId, now))
    return newGroupId
}

/** Limpia peers por timeout y borra grupos vacíos. */
fun purgeDeadPeers() {
    val now = System.currentTimeMillis()
    val timeout = 20_000L

    groupLock.withLock {
        val emptyTypes = mutableListOf<String>()

        groupState.forEach { (type, groups) ->
            val emptyGroups = mutableListOf<String>()

            groups.forEach { (groupId, list) ->
                list.removeIf { now - it.timestamp > timeout }
                if (list.isEmpty()) {
                    emptyGroups.add(groupId)
                }
            }

            emptyGroups.forEach { gid -> groups.remove(gid) }
            if (groups.isEmpty()) emptyTypes.add(type)
        }

        emptyTypes.forEach { t -> groupState.remove(t) }
    }
}