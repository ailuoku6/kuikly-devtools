package com.ailuoku6.kuikly.devtools

import com.tencent.kuikly.core.datetime.DateTime
import com.tencent.kuikly.core.manager.IBridgeCallObserver
import com.tencent.kuikly.core.manager.KotlinMethod
import com.tencent.kuikly.core.manager.NativeMethod
import com.tencent.kuikly.core.nvi.serialization.json.JSONArray
import com.tencent.kuikly.core.nvi.serialization.json.JSONObject

/**
 * Taps `BridgeManager`'s observer hook, which sees every Kotlin<->Native call.
 *
 * This is why logs and network traffic need no instrumentation at all:
 *  - `KLog` (and therefore `TMLog`) reaches native as `callModuleMethod("KRLogModule", ...)`
 *  - `HttpClient.ajax` reaches native as `callModuleMethod("KRNetworkModule", "httpRequest", ...)`
 *  - `HttpService` / `httpGet` / `httpPost` go through `KuiklyTDFModule.asyncCall("network", "fetch")`
 *    (not a direct `callTDFModuleMethod("network", …)`), so the wrapper must be unwrapped
 *  - `fetchMapServer` is `TMKuiklyJCENetworkModule.asyncCallWithBinary("TMNetworkModule", …)` or
 *    Harmony `KuiklyTDFModule.asyncCall("TMNetworkModule", "fetchMapServer")`
 *  - MapSSO long-link is `KuiklyTDFModule.syncCall/asyncCall("TMLongLinkModule", subscribe|observe|…)`
 *    with push data arriving as pager events (`UPDATE_INSTANCE`)
 *  - QMLink / MQTT go through `TMKuiklyLongLinkModule` / `TMKuiklyMQTTModule`
 *  - every response comes back as `callKotlinMethod(FIRE_CALLBACK, pagerId, callbackId, data)`
 *
 * Caveat: `BridgeManager.addCallObserver` stores a single observer per pagerId, so installing this
 * tap replaces any other observer for the same page.
 */
internal class KDevtoolsBridgeTap(private val session: KDevtoolsSession) : IBridgeCallObserver {

    override fun onCallNative(methodId: Int, vararg args: Any?) {
        session.armSamplingLoop()
        when (methodId) {
            NativeMethod.CALL_MODULE_METHOD -> onModuleCall(args)
            NativeMethod.CALL_TDF_MODULE_METHOD -> onTdfModuleCall(args)
            else -> Unit
        }
    }

    override fun onCallKotlin(methodId: Int, vararg args: Any?) {
        when (methodId) {
            KotlinMethod.FIRE_CALLBACK -> onFireCallback(args)
            KotlinMethod.UPDATE_INSTANCE -> onPagerEvent(args)
            KotlinMethod.DESTROY_INSTANCE -> KDevtools.detachPager(session.pagerId)
            else -> Unit
        }
    }

    // --------------------------------------------------------------------- module

    private fun onModuleCall(args: Array<out Any?>) {
        val moduleName = args.getOrNull(1) as? String ?: return
        val method = args.getOrNull(2) as? String ?: return
        when (moduleName) {
            MODULE_LOG -> onLogCall(method, args.getOrNull(3))
            MODULE_NETWORK -> if (method == "httpRequest") {
                onKrNetworkRequest(args.getOrNull(3), args.getOrNull(4) as? String)
            }
            MODULE_QMLINK -> onQmLinkCall(method, args.getOrNull(3), args.getOrNull(4) as? String)
            MODULE_MQTT -> onMqttCall(method, args.getOrNull(3), args.getOrNull(4) as? String)
            MODULE_TDF_WRAPPER -> onTdfWrapperModule(method, args.getOrNull(3), args.getOrNull(4) as? String)
            MODULE_JCE_NETWORK -> if (method == "asyncCallWithBinary" || method == "syncCallWithBinary") {
                val inner = unwrapThreeArgCall(args.getOrNull(3)) ?: return
                dispatchTdfInner(inner.module, inner.method, inner.params, args.getOrNull(4) as? String, null)
            }
        }
    }

    private fun onLogCall(method: String, payload: Any?) {
        val raw = payload as? String ?: return
        val level = when (method) {
            "logInfo" -> KDevtools.LEVEL_INFO
            "logDebug" -> KDevtools.LEVEL_DEBUG
            "logError" -> KDevtools.LEVEL_ERROR
            else -> return
        }
        // KLog formats as "[KLog][tag]:message"; recover the tag for the panel's tag filter.
        var tag = "KLog"
        var message = raw
        if (raw.startsWith("[KLog][")) {
            val close = raw.indexOf("]:", startIndex = 7)
            if (close > 7) {
                tag = raw.substring(7, close)
                message = raw.substring(close + 2)
            }
        }
        session.onLog(level, tag, message)
    }

    private fun onKrNetworkRequest(payload: Any?, callbackId: String?) {
        if (callbackId == null) return
        // Own ingest POSTs must never enter the Network panel (would recurse every tick).
        if (KDevtools.isEmittingOwnUpload) return
        val parsed = when (payload) {
            is JSONObject -> payload
            is String -> parseObject(payload) ?: return
            else -> return
        }
        val url = parsed.optString("url")
        // Prefer the parsed URL: Kuikly JSON escapes `/` as `\/`, so matching INGEST_PATH on the
        // raw bridge string misses the agent's own uploads and loops forever.
        if (url.isEmpty() || KDevtoolsTransport.isOwnServeUrl(url)) return
        session.onNetworkStart(
            NetworkRecord(
                callbackId = callbackId,
                url = url,
                method = parsed.optString("method", "GET"),
                stack = NetworkRecord.STACK_KR_NETWORK,
                requestBody = parsed.optJSONObject("param")?.toString() ?: "",
                requestHeaders = extractRequestHeaders(parsed),
                startedAt = DateTime.currentTimestamp()
            )
        )
    }

    // ------------------------------------------------------------------ tdf module

    private fun onTdfModuleCall(args: Array<out Any?>) {
        val moduleName = args.getOrNull(1) as? String ?: return
        val method = args.getOrNull(2) as? String ?: return
        val payload = args.getOrNull(3)
        val callbacks = args.getOrNull(4) as? String
        if (moduleName == TDF_MODULE_NETWORK && method == "fetch") {
            onTdfFetchParams(parseObject(payload as? String), firstCallbackId(callbacks), errorCallbackId(callbacks))
            return
        }
        if (moduleName == MODULE_TDF_WRAPPER && (method == "syncCall" || method == "asyncCall")) {
            val inner = unwrapThreeArgCall(payload) ?: return
            dispatchTdfInner(inner.module, inner.method, inner.params, firstCallbackId(callbacks), errorCallbackId(callbacks))
            return
        }
        if (moduleName == TDF_MODULE_LONGLINK) {
            onLongLinkMethod(moduleName, method, parseObject(payload as? String), firstCallbackId(callbacks), errorCallbackId(callbacks))
        }
    }

    /**
     * iOS/Android: `toTDFNative("asyncCall", listOf(module, method, mapOf("params" to …)))`.
     * Harmony: `toNative("asyncCall", { module, method, paramJson })`.
     *
     * HttpService uses the wrapper, so "network"/"fetch" must be dispatched here — treating every
     * wrapped call as a long-link silently dropped all HTTP.
     */
    private fun dispatchTdfInner(
        moduleName: String,
        method: String,
        params: JSONObject?,
        successId: String?,
        errorId: String?
    ) {
        when {
            moduleName == TDF_MODULE_NETWORK && method == "fetch" ->
                onTdfFetchParams(params, successId, errorId)
            moduleName == TDF_MODULE_MAP_NETWORK && method == "fetchMapServer" ->
                onMapServerFetch(params, successId, errorId)
            isLongLinkModule(moduleName) ->
                onLongLinkMethod(moduleName, method, params, successId, errorId)
            moduleName == MODULE_MQTT ->
                onMqttCall(method, params?.toString(), successId)
        }
    }

    private fun onTdfWrapperModule(method: String, payload: Any?, callbackId: String?) {
        if (method != "syncCall" && method != "asyncCall") return
        val inner = unwrapThreeArgCall(payload) ?: return
        dispatchTdfInner(inner.module, inner.method, inner.params, callbackId, null)
    }

    private fun onTdfFetchParams(params: JSONObject?, successId: String?, errorId: String?) {
        if (successId.isNullOrEmpty()) return
        if (KDevtools.isEmittingOwnUpload) return
        val parsed = params ?: return
        val url = parsed.optString("url")
        if (url.isEmpty() || KDevtoolsTransport.isOwnServeUrl(url)) return
        val method = parsed.optString("method").ifEmpty { "GET" }
        session.onNetworkStart(
            NetworkRecord(
                callbackId = successId,
                url = url,
                method = method,
                stack = NetworkRecord.STACK_TDF_NETWORK,
                requestBody = parsed.opt("body")?.toString()
                    ?: parsed.optJSONObject("param")?.toString()
                    ?: "",
                requestHeaders = extractRequestHeaders(parsed),
                startedAt = DateTime.currentTimestamp()
            ),
            errorCallbackId = errorId
        )
    }

    private fun onMapServerFetch(params: JSONObject?, successId: String?, errorId: String?) {
        if (successId.isNullOrEmpty()) return
        val parsed = params ?: return
        val url = parsed.optString("url")
        if (url.isEmpty()) return
        val cmd = parsed.opt("cmd")?.toString().orEmpty()
        val subCmd = parsed.optString("subCmd")
        val display = buildString {
            append(url)
            if (cmd.isNotEmpty()) {
                append(if (url.contains("?")) "&" else "?")
                append("cmd=").append(cmd)
                if (subCmd.isNotEmpty()) append("&subCmd=").append(subCmd)
            }
        }
        session.onNetworkStart(
            NetworkRecord(
                callbackId = successId,
                url = display,
                method = "POST",
                stack = NetworkRecord.STACK_MAP_SERVER,
                requestBody = parsed.opt("body")?.toString() ?: "",
                requestHeaders = extractRequestHeaders(parsed),
                startedAt = DateTime.currentTimestamp()
            ),
            errorCallbackId = errorId
        )
    }

    // ------------------------------------------------------------- long-link / mqtt

    private fun onLongLinkMethod(
        moduleName: String,
        method: String,
        params: JSONObject?,
        callbackId: String?,
        errorCallbackId: String?
    ) {
        if (!isLongLinkModule(moduleName)) return
        val now = DateTime.currentTimestamp()
        when (method) {
            "isConnected" -> return
            "subscribe", "subscribeAsync", "observe" -> {
                val inner = unwrapParams(params)
                val cmd = inner.opt("cmd")?.toString().orEmpty()
                val eventName = inner.optString("eventName")
                val sessionId = inner.optString("sessionId")
                val receipt = inner.opt("receiptId")?.toString().orEmpty()
                val id = callbackId?.takeIf { it.isNotEmpty() } ?: session.nextStreamId()
                val key = receipt.ifEmpty { listOf(cmd, eventName, sessionId).filter { it.isNotEmpty() }.joinToString("|") }
                val verb = if (method == "observe") "OBS" else "SUB"
                val url = streamUrl(moduleName, cmd, eventName, sessionId)
                session.onNetworkStart(
                    NetworkRecord(
                        callbackId = id,
                        url = url,
                        method = verb,
                        stack = stackFor(moduleName),
                        requestBody = inner.toString(),
                        startedAt = now,
                        isStream = true,
                        eventName = eventName,
                        receiptKey = key
                    ),
                    errorCallbackId = errorCallbackId
                )
            }
            "unsubscribe", "unsubscribeAll", "unobserve" -> {
                val inner = unwrapParams(params)
                val receipt = inner.opt("receiptId")?.toString().orEmpty()
                val eventName = inner.optString("eventName")
                val record = when {
                    receipt.isNotEmpty() -> session.streamByReceiptKey(receipt)
                    eventName.isNotEmpty() -> session.streamByEventName(eventName)
                    else -> session.latestOpenStream(stackFor(moduleName))
                }
                if (record != null) {
                    session.onStreamFrame(record, NetworkRecord.DIR_UP, inner.toString(), now)
                    session.closeStream(record, true, "", now)
                }
            }
            else -> Unit
        }
    }

    private fun onQmLinkCall(method: String, payload: Any?, callbackId: String?) {
        onLongLinkMethod(MODULE_QMLINK, method, parseObject(payload as? String), callbackId, null)
    }

    private fun onMqttCall(method: String, payload: Any?, callbackId: String?) {
        val parsed = parseObject(payload as? String) ?: JSONObject()
        val topic = parsed.optString("topic")
        val now = DateTime.currentTimestamp()
        when (method) {
            "isConnected" -> return
            "publish" -> {
                val id = callbackId?.takeIf { it.isNotEmpty() } ?: session.nextStreamId()
                session.onNetworkStart(
                    NetworkRecord(
                        callbackId = id,
                        url = "mqtt://$topic",
                        method = "PUB",
                        stack = NetworkRecord.STACK_MQTT,
                        requestBody = parsed.toString(),
                        startedAt = now
                    )
                )
            }
            "subscribe" -> {
                val id = callbackId?.takeIf { it.isNotEmpty() } ?: session.nextStreamId()
                session.onNetworkStart(
                    NetworkRecord(
                        callbackId = id,
                        url = "mqtt://$topic",
                        method = "SUB",
                        stack = NetworkRecord.STACK_MQTT,
                        requestBody = parsed.toString(),
                        startedAt = now,
                        isStream = true,
                        eventName = topic,
                        receiptKey = topic
                    )
                )
            }
            "unsubscribe" -> {
                val record = session.streamByReceiptKey(topic)
                    ?: session.streamByEventName(topic)
                    ?: session.latestOpenStream(NetworkRecord.STACK_MQTT)
                if (record != null) {
                    session.onStreamFrame(record, NetworkRecord.DIR_UP, parsed.toString(), now)
                    session.closeStream(record, true, "", now)
                }
            }
        }
    }

    private fun onPagerEvent(args: Array<out Any?>) {
        val event = args.getOrNull(1) as? String ?: return
        val data = args.getOrNull(2) as? String ?: return
        if (!isLongLinkEvent(event)) return
        val record = session.streamByEventName(event)
            ?: session.latestOpenStream(NetworkRecord.STACK_TDF_LONGLINK)
            ?: session.latestOpenStream(NetworkRecord.STACK_QMLINK)
        val now = DateTime.currentTimestamp()
        if (record != null) {
            session.onStreamFrame(record, NetworkRecord.DIR_DOWN, data, now)
            return
        }
        // A push can arrive before we saw subscribe (syncCall return is invisible to the observer).
        session.onNetworkStart(
            NetworkRecord(
                callbackId = session.nextStreamId(),
                url = "longlink://$event",
                method = "SUB",
                stack = NetworkRecord.STACK_TDF_LONGLINK,
                requestBody = "",
                startedAt = now,
                isStream = true,
                eventName = event,
                receiptKey = event
            )
        )
        session.streamByEventName(event)?.let {
            session.onStreamFrame(it, NetworkRecord.DIR_DOWN, data, now)
        }
    }

    // -------------------------------------------------------------------- callback

    private fun onFireCallback(args: Array<out Any?>) {
        val callbackId = args.getOrNull(1) as? String ?: return
        val record = session.pendingNetwork(callbackId) ?: return
        val data = args.getOrNull(2)
        val json = when (data) {
            is JSONObject -> data
            is String -> parseObject(data)
            else -> null
        }
        val payload = json?.optJSONObject("result") ?: json
        val now = DateTime.currentTimestamp()
        if (record.isStream) {
            val body = when {
                payload != null -> payload.toString()
                json != null -> json.toString()
                data != null -> data.toString()
                else -> ""
            }
            session.onStreamFrame(record, NetworkRecord.DIR_DOWN, body, now)
            val code = payload?.optInt("code", 0) ?: 0
            if (code == CODE_CALLBACK_TIMEOUT) {
                session.closeStream(record, false, "timeout", now)
            }
            return
        }
        // KRNetworkModule: statusCode + data. Hippy/TDF network.fetch: statusCode + respBody,
        // often wrapped as `{ "result": { ... } }`.
        val envelope = httpEnvelope(json, payload, data)
        val status = envelope?.let { it.optInt("statusCode", it.optInt("status", 0)) } ?: 0
        val viaErrorCallback = session.isErrorCallback(callbackId)
        val success = when {
            viaErrorCallback -> false
            envelope != null && envelope.has("success") -> envelope.optInt("success", 0) == 1
            envelope != null && record.stack == NetworkRecord.STACK_MQTT -> envelope.optInt("code", 0) == 0
            status != 0 -> status in 200..299
            else -> true
        }
        val body = extractHttpBody(json, payload, data)
        val errorText = envelope?.optString("errorMsg").orEmpty().ifEmpty {
            envelope?.optString("msg").orEmpty()
        }
        record.complete(
            status = status,
            ok = success,
            error = errorText,
            body = body,
            at = now
        )
    }

    // ------------------------------------------------------------------ parsing

    private data class TdfInner(val module: String, val method: String, val params: JSONObject?)

    /**
     * KuiklyTDFModule serialises `listOf(module, method, mapOf("params" to actual))` as a JSON
     * array. Harmony uses `{ module, method, paramJson }`. JCE binary calls pass
     * `[module, method, paramsJson]`.
     */
    private fun unwrapThreeArgCall(raw: Any?): TdfInner? {
        val module: String
        val method: String
        val third: Any?
        when (raw) {
            is JSONArray -> {
                module = raw.optString(0).orEmpty()
                method = raw.optString(1).orEmpty()
                third = raw.opt(2)
            }
            is String -> {
                val trimmed = raw.trim()
                if (trimmed.startsWith("[")) {
                    val array = try {
                        JSONArray(trimmed)
                    } catch (t: Throwable) {
                        return null
                    }
                    module = array.optString(0).orEmpty()
                    method = array.optString(1).orEmpty()
                    third = array.opt(2)
                } else if (trimmed.startsWith("{")) {
                    val obj = parseObject(trimmed) ?: return null
                    module = obj.optString("module")
                    method = obj.optString("method")
                    third = obj.opt("paramJson") ?: obj.opt("params") ?: obj.optJSONObject("params")
                } else {
                    return null
                }
            }
            else -> return null
        }
        if (module.isEmpty() || method.isEmpty()) return null
        return TdfInner(module, method, coerceParams(third))
    }

    private fun coerceParams(third: Any?): JSONObject? {
        val obj = when (third) {
            null -> return null
            is JSONObject -> third
            is String -> parseObject(third) ?: return null
            else -> parseObject(third.toString()) ?: return null
        }
        return unwrapParams(obj)
    }

    private fun unwrapParams(params: JSONObject?): JSONObject {
        if (params == null) return JSONObject()
        params.optJSONObject("params")?.let { return it }
        return params
    }

    /**
     * Hippy/TDF fetch callbacks look like `{ statusCode, respBody }`. After JSON.parse the same
     * shape may sit under `result`. A bus-line HTTP body is itself JSON and almost always has a
     * nested `data` field — that is the API payload, not the HTTP envelope. Picking `data` there
     * drops craftData / sibling fields and is why a large response looked truncated.
     */
    private fun isHttpEnvelope(obj: JSONObject): Boolean {
        if (obj.has("respBody") || obj.has("respHeaders") || obj.has("statusLine")) return true
        return obj.has("statusCode") && (obj.has("data") || obj.has("header") || obj.has("headers") || obj.has("success"))
    }

    private fun httpEnvelope(json: JSONObject?, payload: JSONObject?, data: Any?): JSONObject? {
        if (payload != null && isHttpEnvelope(payload)) return payload
        if (json != null && isHttpEnvelope(json)) return json
        val result = json?.opt("result")
        if (result is JSONObject && isHttpEnvelope(result)) return result
        if (result is String) {
            parseObject(result)?.takeIf { isHttpEnvelope(it) }?.let { return it }
        }
        if (data is JSONObject && isHttpEnvelope(data)) return data
        if (data is String) {
            parseObject(data)?.takeIf { isHttpEnvelope(it) }?.let { return it }
        }
        return null
    }

    private fun extractHttpBody(json: JSONObject?, payload: JSONObject?, data: Any?): String {
        val envelope = httpEnvelope(json, payload, data)
        if (envelope != null) {
            if (envelope.has("respBody")) return jsonValueToText(envelope.opt("respBody"))
            if (envelope.has("data")) return jsonValueToText(envelope.opt("data"))
            return envelope.toString()
        }
        val resultVal = json?.opt("result")
        if (resultVal is String && resultVal.isNotEmpty()) return resultVal
        when (data) {
            is String -> if (data.isNotEmpty()) return data
            is JSONObject -> return data.toString()
            is JSONArray -> return data.toString()
            null -> Unit
            else -> return data.toString()
        }
        return payload?.toString() ?: json?.toString() ?: ""
    }

    private fun jsonValueToText(value: Any?): String = when (value) {
        null -> ""
        is String -> value
        is JSONObject -> value.toString()
        is JSONArray -> value.toString()
        else -> value.toString()
    }

    /**
     * KRNetworkModule: `{ headers, cookie }`. TDF `network.fetch` / fetchMapServer: `{ headers }`.
     * Cookie is a sibling of headers on the KR path, so fold it in when the map does not already
     * have one — curl and the panel then see a single header block.
     */
    private fun extractRequestHeaders(parsed: JSONObject): String {
        val raw = parsed.opt("headers") ?: parsed.opt("header")
        val headers = when (raw) {
            is JSONObject -> raw
            is String -> parseObject(raw)
            else -> null
        }
        val cookie = parsed.optString("cookie")
        if (cookie.isEmpty()) {
            return if (isEmptyJsonObject(headers)) "" else headers!!.toString()
        }
        val merged = if (isEmptyJsonObject(headers)) {
            JSONObject()
        } else {
            parseObject(headers!!.toString()) ?: JSONObject()
        }
        if (!merged.has("Cookie") && !merged.has("cookie")) {
            merged.put("Cookie", cookie)
        }
        return merged.toString()
    }

    private fun isEmptyJsonObject(obj: JSONObject?): Boolean {
        if (obj == null) return true
        val text = obj.toString()
        return text.isEmpty() || text == "{}"
    }

    private fun parseObject(raw: String?): JSONObject? {
        if (raw.isNullOrEmpty()) return null
        return try {
            JSONObject(raw)
        } catch (t: Throwable) {
            null
        }
    }

    private fun firstCallbackId(callbacks: String?): String? {
        val parsed = parseObject(callbacks) ?: return null
        return parsed.optString("succ").ifEmpty { null }
            ?: parsed.optString("callback").ifEmpty { null }
    }

    private fun errorCallbackId(callbacks: String?): String? {
        val parsed = parseObject(callbacks) ?: return null
        return parsed.optString("error").ifEmpty { null }
    }

    private fun isLongLinkModule(name: String): Boolean =
        name == TDF_MODULE_LONGLINK || name == MODULE_QMLINK

    private fun isLongLinkEvent(event: String): Boolean {
        if (event.isEmpty()) return false
        if (session.streamByEventName(event) != null) return true
        val lower = event.lowercase()
        return lower.contains("longconnect") ||
            lower.contains("longlink") ||
            lower.contains("longconn") ||
            lower.contains("qmlink")
    }

    private fun stackFor(moduleName: String): String = when (moduleName) {
        MODULE_QMLINK -> NetworkRecord.STACK_QMLINK
        MODULE_MQTT -> NetworkRecord.STACK_MQTT
        else -> NetworkRecord.STACK_TDF_LONGLINK
    }

    private fun streamUrl(moduleName: String, cmd: String, eventName: String, sessionId: String): String {
        val scheme = if (moduleName == MODULE_QMLINK) "qmlink" else "longlink"
        val host = when {
            cmd.isNotEmpty() -> "cmd/$cmd"
            eventName.isNotEmpty() -> eventName
            else -> moduleName
        }
        val query = ArrayList<String>()
        if (eventName.isNotEmpty() && !host.contains(eventName)) query.add("event=$eventName")
        if (sessionId.isNotEmpty()) query.add("sid=$sessionId")
        return if (query.isEmpty()) "$scheme://$host" else "$scheme://$host?${query.joinToString("&")}"
    }

    private companion object {
        const val MODULE_LOG = "KRLogModule"
        const val MODULE_NETWORK = "KRNetworkModule"
        const val MODULE_TDF_WRAPPER = "KuiklyTDFModule"
        const val MODULE_QMLINK = "TMKuiklyLongLinkModule"
        const val MODULE_MQTT = "TMKuiklyMQTTModule"
        const val MODULE_JCE_NETWORK = "TMKuiklyJCENetworkModule"
        const val TDF_MODULE_NETWORK = "network"
        const val TDF_MODULE_MAP_NETWORK = "TMNetworkModule"
        const val TDF_MODULE_LONGLINK = "TMLongLinkModule"
        const val CODE_CALLBACK_TIMEOUT = 100
    }
}
