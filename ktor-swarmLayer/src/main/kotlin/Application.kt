package comm

import io.ktor.http.*
import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.application.*
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.server.http.content.*
import io.ktor.server.request.*
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File
import java.io.Writer
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

// ========= DTOs / Models =========

@Serializable
data class PeerRegistration(val id: String)

@Serializable
data class MetricData(
    val fragmentUrl: String,
    val source: String,          // "p2p" o "http"
    val sender: String? = null,  // null/"" si http
    val receiver: String,        // siempre un peer
    val time: Long,              // epoch millis
    val sizeBytes: Long
)

@Serializable
data class MetricsResponse(
    val from: Long,
    val to: Long,
    val minutes: Long,
    val count: Int,
    val totalBytes: Long,
    val items: List<MetricData>
)

@Serializable
data class PeersResponse(val peers: List<String>)

@Serializable
data class KeepAliveResponse(val status: String)

@Serializable
data class OkResponse(val ok: Boolean)

@Serializable
data class ErrorResponse(val error: String)

// ========= Globals =========

// JSON bonito para disco
val jsonPretty = Json { prettyPrint = true }
// JSON compacto para SSE (¡sin saltos de línea!)
val jsonCompact = Json { prettyPrint = false }

val metricsFile = File("metricas.json")
val metricsLock = ReentrantLock()

// ========= Application =========

fun Application.module() {

    // Peers y SSE
    val peerTimestamps = ConcurrentHashMap<String, Long>()
    val timeoutMillis = 30_000L
    val sseClients = Collections.synchronizedSet(mutableSetOf<Writer>())

    install(ContentNegotiation) { json() }

    // Limpieza periódica de peers inactivos
    launch {
        while (true) {
            val now = System.currentTimeMillis()
            val toRemove = peerTimestamps.filterValues { now - it > timeoutMillis }.keys
            toRemove.forEach {
                println("Peer eliminado por timeout: $it")
                peerTimestamps.remove(it)
            }
            delay(5_000)
        }
    }

    // ===== Helpers de métricas =====

    fun readAllMetrics(): List<MetricData> = metricsLock.withLock {
        if (!metricsFile.exists()) return emptyList()
        return runCatching {
            val raw = metricsFile.readText()
            if (raw.isBlank()) emptyList()
            else jsonPretty.decodeFromString<List<MetricData>>(raw)
        }.getOrElse {
            println("⚠️ Error leyendo metricas.json: ${it.message}")
            emptyList()
        }
    }

    fun persistMetric(m: MetricData) = metricsLock.withLock {
        val existing = readAllMetrics()
        val updated = existing + m
        // Escritura atómica: .tmp + rename
        val tmp = File(metricsFile.parentFile ?: File("."), metricsFile.name + ".tmp")
        tmp.writeText(jsonPretty.encodeToString(updated))
        if (!tmp.renameTo(metricsFile)) {
            // Fallback (Windows)
            metricsFile.writeText(tmp.readText())
            tmp.delete()
        }
    }

    /**
     * Emite un evento SSE nombrado 'metric' con JSON compacto.
     * Si hubiera saltos de línea, cada línea se prefija con "data:" (cumple el spec).
     */
    fun broadcastSseMetric(metric: MetricData) {
        val compact = jsonCompact.encodeToString(metric) // una sola línea
        val sb = StringBuilder()
        sb.append("event: metric\n")
        // Por robustez, si alguna vez hubiera \n, enviamos múltiples líneas 'data:'
        compact.split('\n').forEach { line ->
            sb.append("data: ").append(line).append('\n')
        }
        sb.append('\n') // separador de evento
        val payload = sb.toString()

        val dead = mutableListOf<Writer>()
        synchronized(sseClients) {
            sseClients.forEach { w ->
                runCatching {
                    w.write(payload)
                    w.flush()
                }.onFailure { dead += w }
            }
            sseClients.removeAll(dead.toSet())
        }
    }

    // ===== Rutas =====

    routing {
        // Archivos estáticos (si los usas)
        staticResources("/", "static") {}
        staticResources("/hero", "hero") {}
        staticResources("/sprite", "sprite") {}

        // ---- Peers ----
        post("/register") {
            val registration = call.receive<PeerRegistration>()
            peerTimestamps[registration.id] = System.currentTimeMillis()
            println("Peer registrado: ${registration.id}")
            call.respond(HttpStatusCode.OK, PeersResponse(peerTimestamps.keys.toList()))
        }

        post("/keep-alive") {
            val registration = call.receive<PeerRegistration>()
            if (peerTimestamps.containsKey(registration.id)) {
                peerTimestamps[registration.id] = System.currentTimeMillis()
                println("Keep-alive de: ${registration.id}")
                call.respond(HttpStatusCode.OK, KeepAliveResponse("alive"))
            } else {
                println("Keep-alive de peer no registrado: ${registration.id}")
                call.respond(HttpStatusCode.NotFound, ErrorResponse("Peer not registered"))
            }
        }

        post("/unregister") {
            val registration = call.receive<PeerRegistration>()
            if (peerTimestamps.remove(registration.id) != null) {
                println("Peer eliminado manualmente: ${registration.id}")
            } else {
                println("Intento de eliminar peer no registrado: ${registration.id}")
            }
            call.respond(HttpStatusCode.OK, PeersResponse(peerTimestamps.keys.toList()))
        }

        get("/peers") {
            call.respond(HttpStatusCode.OK, PeersResponse(peerTimestamps.keys.toList()))
        }

        // ---- Histórico de métricas ----
        get("/metrics") {
            val minutes = call.request.queryParameters["minutes"]?.toLongOrNull() ?: 5L
            if (minutes <= 0) {
                call.respond(HttpStatusCode.BadRequest, ErrorResponse("minutes must be > 0"))
                return@get
            }

            val now = System.currentTimeMillis()
            val from = now - minutes * 60_000

            val all = readAllMetrics()
            val recent = all.asSequence()
                .filter { it.time in from..now }
                .sortedBy { it.time }
                .toList()

            val totalBytes = recent.sumOf { it.sizeBytes }

            call.respond(
                HttpStatusCode.OK,
                MetricsResponse(
                    from = from,
                    to = now,
                    minutes = minutes,
                    count = recent.size,
                    totalBytes = totalBytes,
                    items = recent
                )
            )
        }

        // ---- SSE en vivo ----
        get("/metrics/live") {
            call.response.cacheControl(CacheControl.NoCache(null))
            call.respondTextWriter(contentType = ContentType.Text.EventStream) {
                synchronized(sseClients) { sseClients += this }
                println("SSE conectado (${sseClients.size} clientes)")
                try {
                    while (true) {
                        // Comentario SSE como heartbeat (NO dispara 'message')
                        write(": keepalive\n\n")
                        flush()
                        delay(15_000)
                    }
                } finally {
                    synchronized(sseClients) { sseClients -= this }
                    println("SSE desconectado (${sseClients.size} clientes)")
                }
            }
        }

        // ---- Ingesta de métricas ----
        post("/metric") {
            val metric = call.receive<MetricData>()
            val normalized = metric.copy(
                source = metric.source.lowercase(),
                sender = if (metric.source.lowercase() == "http") null else metric.sender
            )
            persistMetric(normalized)
            broadcastSseMetric(normalized) // <-- usa JSON compacto y data: por línea
            call.respond(OkResponse(true))
        }

        // ---- Diagnóstico ----
        get("/_diag/metrics-file") {
            val path = metricsFile.absolutePath
            val exists = metricsFile.exists()
            val size = if (exists) metricsFile.length() else 0L
            call.respond(mapOf("path" to path, "exists" to exists, "size" to size))
        }
    }
}
