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
import java.util.concurrent.ConcurrentHashMap



@Serializable
data class PeerRegistration(val id: String)

@Serializable
data class MetricData(
    val fragmentUrl: String,
    val source: String,
    val sender: String? = null,
    val receiver: String,
    val time: Long,
    val sizeBytes: Long
)

val json = Json { prettyPrint = true }
val metricsFile = File("metricas.json")



fun Application.module() {

    // Peers
    val peerTimestamps = ConcurrentHashMap<String, Long>()
    val timeoutMillis = 30_000L

    install(ContentNegotiation) {
        json()
    }

    // Eliminación peers inactivos
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




    routing {
        // Archivos estáticos
        staticResources("/", "static") {}
        staticResources("/hero", "hero") {}
        staticResources("/sprite", "sprite") {}

        post("/register") {
            val registration = call.receive<PeerRegistration>()
            peerTimestamps[registration.id] = System.currentTimeMillis()
            println("Peer registrado: ${registration.id}")
            call.respond(HttpStatusCode.OK, mapOf("peers" to peerTimestamps.keys))
        }

        post("/keep-alive") {
            val registration = call.receive<PeerRegistration>()
            if (peerTimestamps.containsKey(registration.id)) {
                peerTimestamps[registration.id] = System.currentTimeMillis()
                println("Keep-alive de: ${registration.id}")
                call.respond(HttpStatusCode.OK, mapOf("status" to "alive"))
            } else {
                println("Keep-alive de peer no registrado: ${registration.id}")
                call.respond(HttpStatusCode.NotFound, mapOf("error" to "Peer not registered"))
            }
        }

        post("/unregister") {
            val registration = call.receive<PeerRegistration>()
            if (peerTimestamps.remove(registration.id) != null) {
                println("Peer eliminado manualmente: ${registration.id}")
            } else {
                println("Intento de eliminar peer no registrado: ${registration.id}")
            }
            call.respond(HttpStatusCode.OK, mapOf("peers" to peerTimestamps.keys))
        }

        get("/peers") {
            call.respond(HttpStatusCode.OK, mapOf("peers" to peerTimestamps.keys))
        }



        post("/metric") {
            val metric = call.receive<MetricData>()

            // Si el archivo no existe, creamos una lista vacía
            val existing = if (metricsFile.exists()) {
                runCatching {
                    json.decodeFromString<List<MetricData>>(metricsFile.readText())
                }.getOrElse { emptyList() }
            } else emptyList()

            // Añadimos la nueva métrica
            val updated = existing + metric

            // Guardamos todo de nuevo en JSON
            metricsFile.writeText(json.encodeToString(updated))

            call.respond(mapOf("ok" to true))
        }
    }
}
