package com.ailuoku6.kuikly.devtools

import com.tencent.kuikly.core.module.NetworkModule
import com.tencent.kuikly.core.nvi.serialization.json.JSONArray
import com.tencent.kuikly.core.nvi.serialization.json.JSONObject
import com.tencent.kuikly.core.pager.Pager

/**
 * Ships payloads to the DevTools ingest server over Kuikly's own [NetworkModule], which is the only
 * transport available identically on Android, iOS, HarmonyOS and the JS bundle runtime.
 *
 * Commands from the panel ride back on the response body, so one round trip per tick covers both
 * directions and no extra polling channel is needed.
 */
internal class KDevtoolsTransport(private val pager: Pager, private val pagerId: String) {

    /**
     * `127.0.0.1` first so an `adb reverse tcp:<port>` tunnel is preferred on Android; the compiled
     * LAN address is the fallback for iOS / HarmonyOS / Wi-Fi setups.
     */
    private val candidateHosts: List<String> = if (KDevtoolsConfig.HOST == LOOPBACK) {
        listOf(LOOPBACK)
    } else {
        listOf(LOOPBACK, KDevtoolsConfig.HOST)
    }

    private var hostIndex = 0
    private var hostLocked = false
    private var consecutiveFailures = 0

    /** @param done invoked exactly once with the delivery outcome and any commands from the panel. */
    fun send(payload: JSONObject, done: (ok: Boolean, commands: JSONArray?) -> Unit) {
        val module = try {
            pager.acquireModule<NetworkModule>(NetworkModule.MODULE_NAME)
        } catch (t: Throwable) {
            KDevtools.agentLog(KDevtools.LEVEL_ERROR, "NetworkModule unavailable: $t")
            done(false, null)
            return
        }

        val host = candidateHosts[hostIndex % candidateHosts.size]
        val url = "http://$host:${KDevtoolsConfig.PORT}$INGEST_PATH"
        val headers = JSONObject().apply { put("Content-Type", "application/json") }

        // Guard must wrap the sync bridge call only: BridgeTap sees httpRequest before this returns.
        KDevtools.beginOwnUpload()
        try {
            module.httpRequest(url, true, payload, headers, null, TIMEOUT_SECONDS) { data, success, errorMsg, _ ->
                if (success) {
                    if (!hostLocked) {
                        hostLocked = true
                        KDevtools.agentLog(KDevtools.LEVEL_INFO, "ingest endpoint locked to $url")
                    }
                    consecutiveFailures = 0
                    done(true, data.optJSONArray("commands"))
                } else {
                    onFailure(url, errorMsg)
                    done(false, null)
                }
            }
        } catch (t: Throwable) {
            onFailure(url, t.message ?: "throw")
            done(false, null)
        } finally {
            KDevtools.endOwnUpload()
        }
    }

    private fun onFailure(url: String, reason: String) {
        consecutiveFailures++
        if (!hostLocked) {
            hostIndex++
        }
        // Only surface the first couple of failures: an absent server would otherwise spam the log
        // on every single tick.
        if (consecutiveFailures <= 2) {
            KDevtools.agentLog(KDevtools.LEVEL_ERROR, "ingest failed ($url): $reason")
        }
    }

    companion object {
        /**
         * Distinctive path so [KDevtoolsBridgeTap] can recognise and drop the agent's own uploads
         * regardless of which candidate host ended up being used.
         */
        const val INGEST_PATH = "/__kuikly_devtools/ingest"

        /**
         * Shared by ingest, ping, and any future serve routes. Must not contain `/`: Kuikly's
         * JSONStringer escapes slashes as `\/`, so matching a full path against the raw bridge
         * params string fails and the upload would be captured (and loop) forever.
         */
        const val SERVE_PATH_MARKER = "__kuikly_devtools"

        fun isOwnServeUrl(url: String): Boolean =
            url.isNotEmpty() && url.contains(SERVE_PATH_MARKER)

        private const val LOOPBACK = "127.0.0.1"
        private const val TIMEOUT_SECONDS = 30
    }
}
