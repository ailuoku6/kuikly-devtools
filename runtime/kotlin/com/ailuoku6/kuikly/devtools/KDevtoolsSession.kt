package com.ailuoku6.kuikly.devtools

import com.tencent.kuikly.core.base.DeclarativeBaseView
import com.tencent.kuikly.core.datetime.DateTime
import com.tencent.kuikly.core.manager.BridgeManager
import com.tencent.kuikly.core.nvi.serialization.json.JSONArray
import com.tencent.kuikly.core.nvi.serialization.json.JSONObject
import com.tencent.kuikly.core.pager.Pager
import com.tencent.kuikly.core.timer.setTimeout

/**
 * One debugging session per live pager: owns the sampling loop, the capture buffers and the
 * transport back to the DevTools server.
 */
internal class KDevtoolsSession(
    val pagerId: String,
    private val pager: Pager,
    private val className: String
) {

    private val tree = KDevtoolsTree(pager)
    private val tap = KDevtoolsBridgeTap(this)
    private val transport = KDevtoolsTransport(pager, pagerId)
    internal val sessionId: String = nextSessionId()

    private val logs = ArrayList<LogRecord>()
    private val networkOrder = ArrayList<String>()
    private val networkById = HashMap<String, NetworkRecord>()
    private val streamByEvent = HashMap<String, String>()
    private val streamByReceipt = HashMap<String, String>()
    private var streamSerial = 0

    /**
     * Secondary callback id -> primary one.
     *
     * The TDF network module registers separate success and error callbacks, so a failed request
     * comes back under an id the record was never filed under. Without this the row would sit
     * "pending" forever, which is precisely the case worth debugging.
     */
    private val networkAlias = HashMap<String, String>()

    private var logSequence = 0
    private var droppedLogs = 0
    private var tickSequence = 0

    private var loopArmed = false
    private var detached = false
    private var uploadInFlight = false
    private var uploadStartedAt = 0L
    private var needFullSnapshot = true
    private var sampleMs = KDevtoolsConfig.SAMPLE_MS
    private var stateNodeIds: Set<Int> = emptySet()

    /** Logs already handed to an in-flight ingest, so a concurrent destroy can still include them. */
    private var inFlightLogs: ArrayList<LogRecord>? = null
    private var inFlightNetwork: ArrayList<NetworkRecord>? = null
    private var inFlightDropped = 0
    private var pendingScreenshot: JSONObject? = null
    private var screenshotInFlight = false
    private var queuedShotId: Int? = null
    private var queuedShotSample = 2
    private var liveShot = false
    private var liveShotSample = DEFAULT_LIVE_SAMPLE
    private var liveShotInterval = DEFAULT_LIVE_MS
    private var lastLiveShotAt = 0L
    private var lastLiveCostMs = 0L
    /** Set when the tree moves; cleared after a live toImage actually starts. */
    private var liveNeedsFrame = true
    /** When the current log/network batch should be flushed; 0 = no open batch. */
    private var auxDeadlineAt = 0L

    fun attach() {
        @Suppress("DEPRECATION")
        val previous = BridgeManager.currentPageId
        // addCallObserver keys off currentPageId; make sure it lands under this pager.
        @Suppress("DEPRECATION")
        BridgeManager.currentPageId = pagerId
        try {
            BridgeManager.addCallObserver(tap)
        } finally {
            @Suppress("DEPRECATION")
            BridgeManager.currentPageId = previous
        }
    }

    fun detach() {
        if (detached) return
        detached = true
        val now = DateTime.currentTimestamp()
        for (id in networkOrder) {
            networkById[id]?.let { record ->
                if (record.isOpenStream) record.closeStream(true, "page destroyed", now)
            }
        }
        notifyDestroyed()
        logs.clear()
        networkOrder.clear()
        networkById.clear()
        networkAlias.clear()
        streamByEvent.clear()
        streamByReceipt.clear()
        inFlightLogs = null
        inFlightNetwork = null
        screenshotInFlight = false
        pendingScreenshot = null
        queuedShotId = null
        liveShot = false
        lastLiveShotAt = 0L
        lastLiveCostMs = 0L
        liveNeedsFrame = true
        auxDeadlineAt = 0L
        KDevtools.agentLog(KDevtools.LEVEL_INFO, "detached pagerId=$pagerId")
    }

    /**
     * Starts the sampling loop on the first observed bridge call.
     *
     * `attachPager` runs inside the page constructor, i.e. before `PagerManager` has put the pager
     * into its registry, so `setTimeout` is not usable yet. By the time any bridge traffic flows the
     * pager is fully registered.
     */
    fun armSamplingLoop() {
        if (loopArmed || detached) return
        loopArmed = true
        scheduleTick(0)
    }

    private fun scheduleTick(delayMs: Int) {
        if (detached) return
        try {
            setTimeout(pagerId, delayMs) { tick() }
        } catch (t: Throwable) {
            loopArmed = false
            KDevtools.agentLog(KDevtools.LEVEL_ERROR, "scheduleTick failed: $t")
        }
    }

    private fun tick() {
        if (detached) return
        try {
            // Watchdog: a dropped native network callback would otherwise wedge the loop forever.
            if (uploadInFlight && DateTime.currentTimestamp() - uploadStartedAt > UPLOAD_TIMEOUT_MS) {
                uploadInFlight = false
                needFullSnapshot = true
                KDevtools.agentLog(KDevtools.LEVEL_ERROR, "upload timed out, resuming sampling")
            }
            if (!uploadInFlight) {
                upload()
            }
            pumpLiveShot()
        } catch (t: Throwable) {
            KDevtools.agentLog(KDevtools.LEVEL_ERROR, "tick failed: $t")
        } finally {
            scheduleTick(sampleMs)
        }
    }

    // ------------------------------------------------------------------- capturing

    fun onLog(level: String, tag: String, message: String) {
        if (detached) return
        if (logs.size >= MAX_LOGS_BUFFERED) {
            logs.removeAt(0)
            droppedLogs++
        }
        logs.add(LogRecord(level, tag, message, DateTime.currentTimestamp(), logSequence++))
    }

    fun onNetworkStart(record: NetworkRecord, errorCallbackId: String? = null) {
        if (detached) return
        evictIfNeeded()
        networkOrder.add(record.callbackId)
        networkById[record.callbackId] = record
        if (record.eventName.isNotEmpty()) {
            streamByEvent[record.eventName] = record.callbackId
        }
        if (record.receiptKey.isNotEmpty()) {
            streamByReceipt[record.receiptKey] = record.callbackId
        }
        if (errorCallbackId != null && errorCallbackId != record.callbackId) {
            if (networkAlias.size >= MAX_NETWORK_BUFFERED * 2) {
                networkAlias.clear()
            }
            networkAlias[errorCallbackId] = record.callbackId
        }
    }

    fun nextStreamId(): String {
        streamSerial += 1
        return "ll_$pagerId-$streamSerial"
    }

    fun streamByEventName(eventName: String): NetworkRecord? =
        streamByEvent[eventName]?.let { networkById[it] }

    fun streamByReceiptKey(key: String): NetworkRecord? =
        streamByReceipt[key]?.let { networkById[it] }

    fun latestOpenStream(stack: String): NetworkRecord? {
        for (index in networkOrder.lastIndex downTo 0) {
            val record = networkById[networkOrder[index]] ?: continue
            if (record.stack == stack && record.isOpenStream) return record
        }
        return null
    }

    fun onStreamFrame(record: NetworkRecord, dir: String, data: String, at: Long) {
        if (detached) return
        record.addFrame(dir, data, at)
    }

    fun closeStream(record: NetworkRecord, ok: Boolean, error: String, at: Long) {
        if (detached) return
        record.closeStream(ok, error, at)
    }

    private fun evictIfNeeded() {
        if (networkOrder.size < MAX_NETWORK_BUFFERED) return
        var victimIndex = -1
        for (index in networkOrder.indices) {
            val record = networkById[networkOrder[index]]
            if (record != null && !record.isOpenStream) {
                victimIndex = index
                break
            }
        }
        if (victimIndex < 0) victimIndex = 0
        val victim = networkOrder.removeAt(victimIndex)
        val removed = networkById.remove(victim) ?: return
        if (removed.eventName.isNotEmpty()) streamByEvent.remove(removed.eventName)
        if (removed.receiptKey.isNotEmpty()) streamByReceipt.remove(removed.receiptKey)
    }

    fun pendingNetwork(callbackId: String): NetworkRecord? =
        networkById[callbackId] ?: networkAlias[callbackId]?.let { networkById[it] }

    /** True when the id belongs to a request's error callback rather than its success callback. */
    fun isErrorCallback(callbackId: String): Boolean = networkAlias.containsKey(callbackId)

    // -------------------------------------------------------------------- uploading

    private fun upload() {
        val isFull = needFullSnapshot
        val delta = tree.collect(isFull, stateNodeIds)
        if (isFull || delta.changed != 0 || delta.removed.length() != 0) {
            liveNeedsFrame = true
        }

        val flushedNetwork = ArrayList<NetworkRecord>()
        for (id in networkOrder) {
            val record = networkById[id] ?: continue
            if (record.needsUpload()) flushedNetwork.add(record)
        }

        // Tree/screenshot still go out this tick. Logs and dirty network records stay in the
        // buffer until AUX_FLUSH_MS (or a burst cap) so a chatty println does not POST every
        // sample. Chunked bodies flush immediately so a multi-megabyte rsp is not delayed 1.5s
        // per slice.
        val now = DateTime.currentTimestamp()
        val hasTree = isFull || delta.changed != 0 || delta.removed.length() != 0
        val hasShot = pendingScreenshot != null
        val logCount = logs.size
        val netCount = flushedNetwork.size
        val hasBlobs = flushedNetwork.any { it.hasUnsentBlobs() }
        val hasAux = logCount > 0 || netCount > 0
        if (hasAux && auxDeadlineAt == 0L) {
            auxDeadlineAt = now + AUX_FLUSH_MS
        }
        val flushAux = hasAux && (
            hasBlobs ||
                now >= auxDeadlineAt ||
                logCount >= AUX_FLUSH_LOGS ||
                netCount >= AUX_FLUSH_NETWORK
            )

        if (!hasTree && !hasShot && !flushAux) {
            return
        }

        needFullSnapshot = false
        if (hasAux) auxDeadlineAt = 0L

        val flushedLogs = ArrayList(logs)
        val logsJson = JSONArray()
        for (record in flushedLogs) {
            logsJson.put(record.toJson())
        }
        val droppedNow = droppedLogs
        logs.clear()
        droppedLogs = 0

        val networkJson = JSONArray()
        val blobsJson = JSONArray()
        var blobBudget = BLOB_BUDGET_CHARS
        for (record in flushedNetwork) {
            networkJson.put(record.toJson())
            if (blobBudget > 0) {
                blobBudget -= record.drainBlobs(blobBudget, blobsJson)
            }
        }

        val shot = pendingScreenshot
        val attachShot = shot != null && !hasBlobs
        if (attachShot) {
            pendingScreenshot = null
        }

        val payload = JSONObject().apply {
            put("v", PROTOCOL_VERSION)
            put("pagerId", pagerId)
            put("sid", sessionId)
            put("page", safePageName())
            put("class", className)
            put("platform", safePlatform())
            put("seq", tickSequence++)
            put("ts", DateTime.currentTimestamp())
            put("full", isFull)
            put("sampleMs", sampleMs)
            put("droppedLogs", droppedNow)
            put("tree", JSONObject().apply {
                put("nodes", delta.nodes)
                put("removed", delta.removed)
                put("total", delta.total)
                put("changed", delta.changed)
            })
            put("logs", logsJson)
            put("network", networkJson)
            if (blobsJson.length() > 0) {
                put("blobs", blobsJson)
            }
            if (attachShot) {
                put("screenshot", shot)
            }
            if (isFull) {
                put("device", deviceInfo())
            }
        }

        uploadInFlight = true
        uploadStartedAt = DateTime.currentTimestamp()
        inFlightLogs = flushedLogs
        inFlightNetwork = flushedNetwork
        inFlightDropped = droppedNow
        transport.send(payload) { ok, commands ->
            uploadInFlight = false
            inFlightLogs = null
            inFlightNetwork = null
            inFlightDropped = 0
            if (ok) {
                for (record in flushedNetwork) {
                    record.commitDrain()
                }
            } else {
                for (record in flushedNetwork) {
                    record.revertDrain()
                }
            }
            if (detached) return@send
            if (ok) {
                commands?.let { applyCommands(it) }
            } else {
                // Put what we could not deliver back at the front of the buffer, and ask for a full
                // snapshot next time since the receiver never saw this delta.
                restoreLogs(flushedLogs)
                droppedLogs += droppedNow
                if (attachShot && shot != null && pendingScreenshot == null) {
                    pendingScreenshot = shot
                }
                needFullSnapshot = true
            }
        }
    }

    /**
     * Last ingest of this pager: remaining logs/network plus `destroyed: true`.
     *
     * Bodies are still sliced to [BLOB_BUDGET_CHARS] per POST — stuffing every leftover megabyte
     * into the destroy notice would fail the same Kuikly `toNative` / HTTP cap as a live tick.
     * The hub keeps the session until those follow-up POSTs reassemble, then drops it.
     * Fire-and-forget: the pager is going away and may not deliver callbacks.
     */
    private fun notifyDestroyed() {
        val pendingLogs = ArrayList<LogRecord>()
        inFlightLogs?.let { pendingLogs.addAll(it) }
        pendingLogs.addAll(logs)

        val pendingNetwork = ArrayList<NetworkRecord>()
        val seen = HashSet<String>()
        fun addNetwork(record: NetworkRecord) {
            if (seen.add(record.callbackId)) pendingNetwork.add(record)
        }
        inFlightNetwork?.forEach { addNetwork(it) }
        for (id in networkOrder) {
            networkById[id]?.let { addNetwork(it) }
        }

        val logsJson = JSONArray()
        for (record in pendingLogs) logsJson.put(record.toJson())
        val networkJson = JSONArray()
        for (record in pendingNetwork) networkJson.put(record.toJson())

        val blobQueue = ArrayList<JSONObject>()
        for (record in pendingNetwork) blobQueue.addAll(record.snapshotBlobs())

        var offset = 0
        var first = true
        do {
            val blobsJson = JSONArray()
            var used = 0
            val start = offset
            while (offset < blobQueue.size) {
                val blob = blobQueue[offset]
                val size = blob.optString("data").length
                if (offset > start && used + size > BLOB_BUDGET_CHARS) break
                blobsJson.put(blob)
                used += size
                offset++
            }
            val payload = JSONObject().apply {
                put("v", PROTOCOL_VERSION)
                put("pagerId", pagerId)
                put("sid", sessionId)
                put("page", safePageName())
                put("class", className)
                put("platform", safePlatform())
                put("seq", tickSequence++)
                put("ts", DateTime.currentTimestamp())
                put("destroyed", true)
                put("network", networkJson)
                if (first) {
                    put("droppedLogs", droppedLogs + inFlightDropped)
                    put("logs", logsJson)
                }
                if (blobsJson.length() > 0) {
                    put("blobs", blobsJson)
                }
            }
            first = false
            try {
                transport.send(payload) { _, _ -> }
            } catch (_: Throwable) {
                // The page is dying; a failed last notice just leaves the archive until serve restarts.
            }
        } while (offset < blobQueue.size)
    }

    /** Re-queues undelivered logs ahead of newer ones, respecting the buffer cap. */
    private fun restoreLogs(undelivered: List<LogRecord>) {
        if (undelivered.isEmpty()) return
        val combined = ArrayList<LogRecord>(undelivered.size + logs.size)
        combined.addAll(undelivered)
        combined.addAll(logs)
        logs.clear()
        val overflow = combined.size - MAX_LOGS_BUFFERED
        if (overflow > 0) {
            droppedLogs += overflow
            logs.addAll(combined.subList(overflow, combined.size))
        } else {
            logs.addAll(combined)
        }
    }

    /**
     * Page or node screenshot via `DeclarativeBaseView.toImage(DATA_URI)`.
     *
     * `id <= 0` means the pager root (the whole page). The callback is async, so the result rides
     * on a later ingest tick rather than blocking the sampling loop.
     *
     * Live captures skip the one-shot queue: if a toImage is already in flight, this interval is
     * dropped so the device cannot pile up screenshots faster than native can produce them.
     */
    private fun captureScreenshot(nodeId: Int, sampleSize: Int, fromLive: Boolean = false) {
        if (detached) return
        val sample = sampleSize.coerceIn(MIN_SHOT_SAMPLE, MAX_SHOT_SAMPLE)
        if (screenshotInFlight) {
            if (!fromLive) {
                queuedShotId = nodeId
                queuedShotSample = sample
            }
            return
        }
        val view: DeclarativeBaseView<*, *>? = if (nodeId <= 0) {
            pager
        } else {
            try {
                pager.getViewWithNativeRef(nodeId) as? DeclarativeBaseView<*, *>
            } catch (t: Throwable) {
                null
            }
        }
        if (view == null) {
            pendingScreenshot = screenshotError(nodeId, sample, "view not found")
            if (fromLive) lastLiveShotAt = DateTime.currentTimestamp()
            return
        }
        // Virtual nodes never grow a RenderView, so toImage would queue forever.
        if (view.renderView == null && nodeId > 0) {
            pendingScreenshot = screenshotError(nodeId, sample, "no RenderView (virtual node)")
            return
        }
        screenshotInFlight = true
        if (fromLive) {
            lastLiveShotAt = DateTime.currentTimestamp()
            liveNeedsFrame = false
        }
        try {
            view.toImage(DeclarativeBaseView.ImageType.DATA_URI, sample) { result ->
                screenshotInFlight = false
                if (detached) return@toImage
                val now = DateTime.currentTimestamp()
                if (fromLive && lastLiveShotAt != 0L) {
                    lastLiveCostMs = (now - lastLiveShotAt).coerceAtLeast(0L)
                }
                val code = result?.optInt("code") ?: -1
                val data = result?.optString("data").orEmpty()
                var ok = false
                pendingScreenshot = JSONObject().apply {
                    put("id", if (nodeId <= 0) view.nativeRef else nodeId)
                    put("ts", now)
                    put("sample", sample)
                    if (fromLive) put("live", true)
                    putCapturedFrame(this, view)
                    if (code == 0 && data.isNotEmpty()) {
                        val uri = asDataUri(data)
                        if (uri.length > MAX_SCREENSHOT_CHARS) {
                            put("err", "screenshot too large (${uri.length} chars); increase sample")
                        } else {
                            put("data", uri)
                            ok = true
                        }
                    } else {
                        put("err", result?.optString("message").orEmpty().ifEmpty { "toImage failed code=$code" })
                    }
                }
                if (fromLive && !ok) liveNeedsFrame = true
                flushQueuedShot()
            }
        } catch (t: Throwable) {
            screenshotInFlight = false
            if (fromLive) liveNeedsFrame = true
            pendingScreenshot = screenshotError(nodeId, sample, t.message ?: "toImage threw")
            flushQueuedShot()
        }
    }

    /**
     * Live page screenshots piggy-back on the sampling loop. toImage is the hot path on device, so
     * we only fire when the tree actually moved, native is idle, no ingest is in flight, and at
     * least [liveShotInterval] (and 2× the last capture cost) has elapsed.
     */
    private fun pumpLiveShot() {
        if (!liveShot || detached || screenshotInFlight || uploadInFlight) return
        if (!liveNeedsFrame) return
        val now = DateTime.currentTimestamp()
        val gap = maxOf(liveShotInterval.toLong(), lastLiveCostMs * 2)
        if (lastLiveShotAt != 0L && now - lastLiveShotAt < gap) return
        captureScreenshot(0, liveShotSample, fromLive = true)
    }

    private fun putCapturedFrame(target: JSONObject, view: DeclarativeBaseView<*, *>) {
        val local = try {
            view.frame
        } catch (t: Throwable) {
            null
        } ?: return
        val absolute = try {
            view.convertFrame(local, null)
        } catch (t: Throwable) {
            null
        }
        target.put("ox", roundFrame(absolute?.x ?: local.x))
        target.put("oy", roundFrame(absolute?.y ?: local.y))
        target.put("ow", roundFrame(local.width))
        target.put("oh", roundFrame(local.height))
    }

    private fun roundFrame(value: Float): Double {
        val scaled = (value * 100f).toInt()
        return scaled / 100.0
    }

    private fun flushQueuedShot() {
        val nextId = queuedShotId ?: return
        queuedShotId = null
        captureScreenshot(nextId, queuedShotSample)
    }

    private fun asDataUri(data: String): String {
        if (data.startsWith("data:", ignoreCase = true)) return data
        return "data:image/png;base64,$data"
    }

    private fun screenshotError(nodeId: Int, sample: Int, message: String): JSONObject = JSONObject().apply {
        put("id", nodeId)
        put("ts", DateTime.currentTimestamp())
        put("sample", sample)
        put("err", message)
    }

    private fun commandFlag(command: JSONObject, key: String, default: Boolean): Boolean {
        if (!command.has(key)) return default
        val raw = command.opt(key)
        if (raw is Boolean) return raw
        val text = command.optString(key)
        if (text == "false" || text == "0") return false
        if (text == "true" || text == "1") return true
        return command.optInt(key, if (default) 1 else 0) != 0
    }

    private fun applyCommands(commands: JSONArray) {
        for (index in 0 until commands.length()) {
            val command = commands.optJSONObject(index) ?: continue
            when (command.optString("type")) {
                "full" -> needFullSnapshot = true
                "state" -> {
                    val ids = HashSet<Int>()
                    command.optJSONArray("ids")?.let { array ->
                        for (i in 0 until array.length()) {
                            ids.add(array.optInt(i))
                        }
                    }
                    stateNodeIds = ids
                    needFullSnapshot = true
                }
                "sample" -> {
                    val value = command.optInt("value", sampleMs)
                    if (value in MIN_SAMPLE_MS..MAX_SAMPLE_MS) {
                        sampleMs = value
                    }
                }
                "clear" -> {
                    logs.clear()
                    networkOrder.clear()
                    networkById.clear()
                    networkAlias.clear()
                    streamByEvent.clear()
                    streamByReceipt.clear()
                }
                "shot" -> {
                    val id = command.optInt("id", 0)
                    val sample = command.optInt("sample", DEFAULT_SHOT_SAMPLE)
                    captureScreenshot(id, sample)
                }
                "live" -> {
                    liveShot = commandFlag(command, "on", true)
                    val interval = command.optInt("interval", liveShotInterval)
                    if (interval in MIN_LIVE_MS..MAX_LIVE_MS) liveShotInterval = interval
                    val sample = command.optInt("sample", liveShotSample)
                    if (sample in MIN_SHOT_SAMPLE..MAX_SHOT_SAMPLE) liveShotSample = sample
                    if (liveShot) {
                        liveNeedsFrame = true
                        lastLiveShotAt = 0L
                        pumpLiveShot()
                    }
                }
            }
        }
    }

    private fun safePageName(): String = try {
        pager.pageName
    } catch (t: Throwable) {
        className
    }

    private fun safePlatform(): String = try {
        pager.pageData.platform.ifEmpty { "unknown" }
    } catch (t: Throwable) {
        "unknown"
    }

    private fun deviceInfo(): JSONObject = JSONObject().apply {
        try {
            val data = pager.pageData
            put("platform", data.platform)
            put("osVersion", data.osVersion)
            put("appVersion", data.appVersion)
            put("density", data.density.toDouble())
            put("pageWidth", data.pageViewWidth.toDouble())
            put("pageHeight", data.pageViewHeight.toDouble())
            put("deviceWidth", data.deviceWidth.toDouble())
            put("deviceHeight", data.deviceHeight.toDouble())
            put("statusBarHeight", data.statusBarHeight.toDouble())
            put("params", data.params)
        } catch (t: Throwable) {
            put("error", t.message ?: "unavailable")
        }
    }

    private companion object {
        const val PROTOCOL_VERSION = 1
        const val MAX_LOGS_BUFFERED = 2000
        const val MAX_NETWORK_BUFFERED = 500
        const val MIN_SAMPLE_MS = 100
        const val MAX_SAMPLE_MS = 5000
        const val DEFAULT_SHOT_SAMPLE = 2
        const val MIN_SHOT_SAMPLE = 1
        const val MAX_SHOT_SAMPLE = 8
        const val DEFAULT_LIVE_MS = 2000
        const val MIN_LIVE_MS = 500
        const val MAX_LIVE_MS = 5000
        const val DEFAULT_LIVE_SAMPLE = 4
        /** Hold logs/network at least this long unless a tree/screenshot ingest is already going out. */
        const val AUX_FLUSH_MS = 1500L
        const val AUX_FLUSH_LOGS = 64
        const val AUX_FLUSH_NETWORK = 16
        const val MAX_SCREENSHOT_CHARS = 8_000_000
        /** Payload budget for body chunks on one ingest POST (chars of chunk data, not JSON). */
        const val BLOB_BUDGET_CHARS = 160_000

        /** Comfortably above the transport's own 30 s request timeout. */
        const val UPLOAD_TIMEOUT_MS = 45000L

        private var sessionSerial = 0

        private fun nextSessionId(): String {
            sessionSerial += 1
            return "${DateTime.currentTimestamp()}-$sessionSerial"
        }
    }
}
