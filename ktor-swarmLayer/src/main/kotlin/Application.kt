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
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

@Serializable
data class PeerRegistration(val id: String)

@Serializable
data class Metric(
    val source: String,           // "p2p" o "http"
    val fragmentUrl: String? = null,
    val timestamp: Long,
    val senderPeerId: String? = null,
    val receiverPeerId: String? = null,
    val sizeBytes: Long
)

fun Application.module() {

    // ---- MAPA DE PEERS ----
    val peerTimestamps = ConcurrentHashMap<String, Long>()
    val timeoutMillis = 30_000L

    // ---- MÉTRICAS EN MEMORIA ----
    val metrics = CopyOnWriteArrayList<Metric>()
    val metricsRetentionMillis = 12 * 60 * 60 * 1000L // 12h máx en memoria

    // --- JSON SERIALIZATION ---
    install(ContentNegotiation) {
        json()
    }

    // --- LIMPIEZA DE PEERS EXPIRADOS ---
    launch {
        while (true) {
            val now = System.currentTimeMillis()
            val toRemove = peerTimestamps.filterValues { now - it > timeoutMillis }.keys
            toRemove.forEach {
                println("🔥 Peer eliminado por timeout: $it")
                peerTimestamps.remove(it)
            }
            delay(5_000)
        }
    }

    // --- LIMPIEZA DE MÉTRICAS ANTIGUAS ---
    launch {
        while (true) {
            val now = System.currentTimeMillis()
            metrics.removeIf { now - it.timestamp > metricsRetentionMillis }
            delay(60_000) // limpiar cada 1 min
        }
    }

    // --- RUTAS ---
    routing {
        // Archivos estáticos
        staticResources("/", "static") {}
        staticResources("/hero", "hero") {}
        staticResources("/sprite", "sprite") {}

        // --- Registro y control de peers ---
        post("/register") {
            val registration = call.receive<PeerRegistration>()
            peerTimestamps[registration.id] = System.currentTimeMillis()
            println("✅ Peer registrado: ${registration.id}")
            call.respond(HttpStatusCode.OK, mapOf("peers" to peerTimestamps.keys))
        }

        post("/keep-alive") {
            val registration = call.receive<PeerRegistration>()
            if (peerTimestamps.containsKey(registration.id)) {
                peerTimestamps[registration.id] = System.currentTimeMillis()
                println("📡 Keep-alive de: ${registration.id}")
                call.respond(HttpStatusCode.OK, mapOf("status" to "alive"))
            } else {
                println("❌ Keep-alive de peer no registrado: ${registration.id}")
                call.respond(HttpStatusCode.NotFound, mapOf("error" to "Peer not registered"))
            }
        }

        post("/unregister") {
            val registration = call.receive<PeerRegistration>()
            if (peerTimestamps.remove(registration.id) != null) {
                println("🚪 Peer eliminado manualmente: ${registration.id}")
            } else {
                println("⚠️ Intento de eliminar peer no registrado: ${registration.id}")
            }
            call.respond(HttpStatusCode.OK, mapOf("peers" to peerTimestamps.keys))
        }

        get("/peers") {
            call.respond(HttpStatusCode.OK, mapOf("peers" to peerTimestamps.keys))
        }

        // --- MÉTRICAS ---
        post("/metric") {
            val metric = call.receive<Metric>()
            metrics.add(metric)
            println("📊 Métrica recibida: ${metric.source} ${metric.sizeBytes} bytes (${metric.senderPeerId}→${metric.receiverPeerId})")
            call.respond(HttpStatusCode.OK)
        }

        get("/metrics") {
            val minutes = call.request.queryParameters["minutes"]?.toLongOrNull() ?: 10
            val cutoff = System.currentTimeMillis() - (minutes * 60 * 1000)
            val recent = metrics.filter { it.timestamp >= cutoff }
            call.respond(HttpStatusCode.OK, recent)
        }
    }
}
