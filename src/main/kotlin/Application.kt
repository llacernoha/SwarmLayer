package comm

import io.ktor.http.*
import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.application.*
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.server.http.content.*
import io.ktor.server.request.*
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable

@Serializable
data class PeerRegistration(val id: String)

fun Application.module() {
    // Mapa para manejar los timeouts activos por peer ID
    val peerTimeouts = mutableMapOf<String, Job>()  // Peer ID → Timeout Job

    install(ContentNegotiation) {
        json()
    }


    // TODO - Hacer una corutina que revise la lista de timestamps y compruebe con su propio reloj,
    //  TODO - si ha pasado más de x segundos, se elimina


    // Reinicia (o inicia) un timeout para un peer
    fun resetTimeout(id: String, app: Application) {
        println("⏳ Reiniciando timeout para: $id")
        peerTimeouts[id]?.cancel()  // Cancela timeout anterior si existe

        peerTimeouts[id] = app.launch {
            println("⌛ Timeout iniciado para $id")
            delay(20_000)  // Espera 20s
            peerTimeouts.remove(id)  // Elimina si no hubo keep-alive
            println("🔥 Peer eliminado por timeout: $id")
        }
    }

    routing {
        staticResources("/", "static") {}
        staticResources("/hero", "hero") {}

        // Registro de peer: inicia timeout si es nuevo
        post("/register") {
            val registration = call.receive<PeerRegistration>()
            if (!peerTimeouts.containsKey(registration.id)) {
                println("✅ Peer registrado: ${registration.id}")
                resetTimeout(registration.id, call.application)
            }
            call.respond(HttpStatusCode.OK, mapOf("peers" to peerTimeouts.keys))
        }

        // Keep-alive para mantener al peer conectado
        post("/keep-alive") {
            val registration = call.receive<PeerRegistration>()
            println("📡 Keep-alive de: ${registration.id}")
            if (peerTimeouts.containsKey(registration.id)) {
                resetTimeout(registration.id, call.application)
                call.respond(HttpStatusCode.OK, mapOf("status" to "alive"))
            } else {
                println("❌ Keep-alive de peer no registrado: ${registration.id}")
                call.respond(HttpStatusCode.NotFound, mapOf("error" to "Peer not registered"))
            }
        }

        // Obtener peers actualmente activos
        get("/peers") {
            call.respond(HttpStatusCode.OK, mapOf("peers" to peerTimeouts.keys))
        }

        // Desconectar explícitamente un peer
        post("/unregister") {
            val registration = call.receive<PeerRegistration>()
            if (peerTimeouts.remove(registration.id) != null) {
                println("🚪 Peer eliminado manualmente: ${registration.id}")
            } else {
                println("⚠️ Intento de eliminar peer no registrado: ${registration.id}")
            }
            call.respond(HttpStatusCode.OK, mapOf("peers" to peerTimeouts.keys))
        }
    }
}
