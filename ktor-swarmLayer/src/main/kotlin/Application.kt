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
import java.io.File
import java.io.Writer
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

// ---- DTOs mínimos ----

@Serializable
data class PeerRegistration(val id: String)

@Serializable
data class MetricData(
    val fragmentUrl: String,
    val source: String,   // "p2p" o "http"
    val sender: String? = null,
    val receiver: String,
    val time: Long,
    val sizeBytes: Long
)

// ---- JSON + fichero métricas ----

private val jsonPretty = Json { prettyPrint = true }
private val jsonCompact = Json { prettyPrint = false }
private val metricsFile = File("metricas.json")
private val metricsLock = ReentrantLock()

fun Application.module() {

    val peerTimestamps = ConcurrentHashMap<String, Long>()
    val timeoutMillis = 30_000L
    val sseClients = Collections.synchronizedSet(mutableSetOf<Writer>())

    install(ContentNegotiation) { json() }

    // Limpieza de peers inactivos
    launch {
        while (true) {
            val now = System.currentTimeMillis()
            val muertos = peerTimestamps.filterValues { now - it > timeoutMillis }.keys
            muertos.forEach {
                println("Peer eliminado por timeout: $it")
                peerTimestamps.remove(it)
            }
            delay(5_000)
        }
    }

    fun readAllMetrics(): List<MetricData> = metricsLock.withLock {
        if (!metricsFile.exists()) return emptyList()

        runCatching {
            val raw = metricsFile.readText()
            if (raw.isBlank()) {
                emptyList()
            } else {
                jsonPretty.decodeFromString<List<MetricData>>(raw)
            }
        }.getOrElse {
            emptyList()
        }
    }


    routing {
        // Estáticos (borra si no los usas)
        staticResources("/", "static")
        staticResources("/hero", "hero")
        staticResources("/sprite", "sprite")

        // ---- Peers ----

        post("/register") {
            val reg = call.receive<PeerRegistration>()
            peerTimestamps[reg.id] = System.currentTimeMillis()
            println("Peer registrado: ${reg.id}")
            call.respond(peerTimestamps.keys.toList())      // [ "peer1", "peer2", ... ]
        }

        post("/keep-alive") {
            val reg = call.receive<PeerRegistration>()
            if (peerTimestamps.containsKey(reg.id)) {
                peerTimestamps[reg.id] = System.currentTimeMillis()
                println("Keep-alive de: ${reg.id}")
                call.respond(mapOf("status" to "alive"))
            } else {
                println("Keep-alive de peer no registrado: ${reg.id}")
                call.respond(HttpStatusCode.NotFound, mapOf("error" to "Peer not registered"))
            }
        }

        post("/unregister") {
            val reg = call.receive<PeerRegistration>()
            if (peerTimestamps.remove(reg.id) != null)
                println("Peer eliminado manualmente: ${reg.id}")
            else
                println("Intento de eliminar peer no registrado: ${reg.id}")
            call.respond(peerTimestamps.keys.toList())
        }

        get("/peers") {
            call.respond(peerTimestamps.keys.toList())
        }

        // ---- Histórico de métricas ----

        get("/metrics") {
            val minutes = call.request.queryParameters["minutes"]?.toLongOrNull() ?: 5L
            if (minutes <= 0) {
                call.respond(HttpStatusCode.BadRequest, mapOf("error" to "minutes must be > 0"))
                return@get
            }

            val now = System.currentTimeMillis()
            val from = now - minutes * 60_000

            val recent = readAllMetrics()
                .asSequence()
                .filter { it.time in from..now }
                .sortedBy { it.time }
                .toList()

            val totalBytes = recent.sumOf { it.sizeBytes }

            call.respond(
                mapOf(
                    "from" to from,
                    "to" to now,
                    "minutes" to minutes,
                    "count" to recent.size,
                    "totalBytes" to totalBytes,
                    "items" to recent
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

        // ---- Ingesta de métricas + broadcast SSE ----

        post("/metric") {
            val metric = call.receive<MetricData>()
            val normalized = metric.copy(
                source = metric.source.lowercase(),
                sender = if (metric.source.lowercase() == "http") null else metric.sender
            )

            // Guardar en fichero
            metricsLock.withLock {
                val updated = readAllMetrics() + normalized
                val tmp = File(metricsFile.parentFile ?: File("."), metricsFile.name + ".tmp")
                tmp.writeText(jsonPretty.encodeToString(updated))
                if (!tmp.renameTo(metricsFile)) {
                    metricsFile.writeText(tmp.readText())
                    tmp.delete()
                }
            }

            // Emitir por SSE
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

        // ---- Diagnóstico ----

        get("/_diag/metrics-file") {
            val exists = metricsFile.exists()
            call.respond(
                mapOf(
                    "path" to metricsFile.absolutePath,
                    "exists" to exists,
                    "size" to if (exists) metricsFile.length() else 0L
                )
            )
        }
    }
}
