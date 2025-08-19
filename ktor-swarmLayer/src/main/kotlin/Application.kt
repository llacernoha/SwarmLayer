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

@Serializable
data class PeerRegistration(val id: String)

fun Application.module() {
    val peerTimestamps = ConcurrentHashMap<String, Long>()
    val timeoutMillis = 20_000L

    // --- Serialization / JSON ---
    install(ContentNegotiation) {
        json()
    }

    // --- Coroutine periódica para eliminar peers expirados ---
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

    // --- Rutas ---
    routing {
        // Archivos estáticos
        staticResources("/", "static") {}
        staticResources("/hero", "hero") {}
        staticResources("/sprite", "sprite") {}

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

        get("/peers") {
            call.respond(HttpStatusCode.OK, mapOf("peers" to peerTimestamps.keys))
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
    }
}
