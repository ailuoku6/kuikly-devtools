package com.ailuoku6.kuikly.devtools

import com.tencent.kuikly.core.nvi.serialization.json.JSONArray
import com.tencent.kuikly.core.nvi.serialization.json.JSONObject
import kotlin.math.min

internal class LogRecord(
    private val level: String,
    private val tag: String,
    private val message: String,
    private val timestamp: Long,
    private val sequence: Int
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("seq", sequence)
        put("lv", level)
        put("tag", tag)
        put("msg", message)
        put("ts", timestamp)
    }
}

/**
 * One captured request. Bodies larger than [INLINE_MAX] are not put on the ingest JSONObject;
 * they go out as [blobs] chunks so Kuikly's `toNative` / HTTP path never has to stringify tens of
 * megabytes in one go. The server concatenates chunks into the original string.
 */
internal class NetworkRecord(
    val callbackId: String,
    private val url: String,
    private val method: String,
    val stack: String,
    requestBody: String,
    private val startedAt: Long,
    private val requestHeaders: String = "",
    val isStream: Boolean = false,
    val eventName: String = "",
    val receiptKey: String = ""
) {
    private val requestInline: String
    private val requestChars: Int
    private var finishedAt: Long = 0
    private var statusCode: Int = 0
    private var success: Boolean = false
    private var errorMessage: String = ""
    private var responseInline: String = ""
    private var responseChars: Int = 0
    private var frameSeq = 0
    private val pendingFrames = ArrayList<PendingFrame>()
    private var frameCount = 0
    private val unsentBlobs = ArrayList<JSONObject>()
    private var drainCount = 0

    var dirty: Boolean = true
        private set

    val isOpenStream: Boolean get() = isStream && finishedAt == 0L

    init {
        if (requestBody.length <= INLINE_MAX) {
            requestInline = requestBody
            requestChars = requestBody.length
        } else {
            requestInline = ""
            requestChars = requestBody.length
            enqueueChunks(FIELD_REQ, requestBody)
        }
    }

    fun needsUpload(): Boolean = dirty || unsentBlobs.isNotEmpty()

    fun hasUnsentBlobs(): Boolean = unsentBlobs.isNotEmpty()

    fun snapshotBlobs(): List<JSONObject> = ArrayList(unsentBlobs)

    fun complete(status: Int, ok: Boolean, error: String, body: String, at: Long) {
        finishedAt = at
        statusCode = status
        success = ok
        errorMessage = error
        if (body.length <= INLINE_MAX) {
            responseInline = body
            responseChars = body.length
        } else {
            responseInline = ""
            responseChars = body.length
            enqueueChunks(FIELD_RSP, body)
        }
        dirty = true
    }

    fun addFrame(dir: String, data: String, at: Long) {
        if (pendingFrames.size >= MAX_PENDING_FRAMES) {
            dropOldestFrame()
        }
        val seq = frameSeq++
        if (data.length <= INLINE_MAX) {
            pendingFrames.add(PendingFrame(seq, dir, at, data, 0))
        } else {
            pendingFrames.add(PendingFrame(seq, dir, at, "", data.length))
            enqueueChunks(FIELD_FRAME, data, seq, dir, at)
        }
        frameCount++
        if (data.length <= INLINE_MAX) {
            responseInline = data
            responseChars = data.length
        } else {
            responseInline = ""
            responseChars = data.length
        }
        dirty = true
    }

    fun closeStream(ok: Boolean, error: String, at: Long) {
        if (finishedAt > 0) return
        finishedAt = at
        success = ok
        statusCode = if (ok) 200 else 0
        if (error.isNotEmpty()) errorMessage = error
        dirty = true
    }

    /**
     * Appends as many queued chunks as [budget] allows. The first chunk always goes out even if it
     * is the only occupant of this ingest. Call [commitDrain] after a successful POST.
     */
    fun drainBlobs(budget: Int, into: JSONArray): Int {
        drainCount = 0
        var used = 0
        while (drainCount < unsentBlobs.size) {
            val blob = unsentBlobs[drainCount]
            val size = blob.optString("data").length
            if (drainCount > 0 && used + size > budget) break
            into.put(blob)
            used += size
            drainCount++
            if (used >= budget) break
        }
        return used
    }

    fun commitDrain() {
        if (drainCount > 0) {
            unsentBlobs.subList(0, drainCount).clear()
        }
        drainCount = 0
        if (unsentBlobs.isEmpty()) {
            dirty = false
            pendingFrames.clear()
        } else {
            dirty = true
        }
    }

    fun revertDrain() {
        drainCount = 0
    }

    fun markClean() {
        if (unsentBlobs.isEmpty()) {
            dirty = false
            pendingFrames.clear()
        }
    }

    /**
     * Always emits the request fields, including on completion. The receiving side merges by id and
     * refuses to overwrite a known value with a blank one, so repeating them is both cheap and the
     * thing that keeps a completed row from going anonymous.
     *
     * Stream records additionally send only the frames that arrived since the last successful upload;
     * the server concatenates them. Large frame payloads travel as [blobs], not inside `msgs`.
     */
    fun toJson(): JSONObject = JSONObject().apply {
        put("id", callbackId)
        put("url", url)
        put("method", method)
        put("stack", stack)
        if (requestHeaders.isNotEmpty()) put("hdr", requestHeaders)
        putBody(this, FIELD_REQ, requestInline, requestChars)
        put("ts", startedAt)
        if (isStream) {
            put("kind", KIND_STREAM)
            put("frames", frameCount)
            val msgs = JSONArray()
            for (frame in pendingFrames) {
                msgs.put(JSONObject().apply {
                    put("seq", frame.seq)
                    put("dir", frame.dir)
                    put("ts", frame.ts)
                    if (frame.data.isNotEmpty()) put("data", frame.data)
                    else if (frame.dataChars > 0) put("dataChars", frame.dataChars)
                })
            }
            put("msgs", msgs)
        }
        if (finishedAt > 0) {
            put("cost", finishedAt - startedAt)
            put("status", statusCode)
            put("ok", success)
            putBody(this, FIELD_RSP, responseInline, responseChars)
            if (errorMessage.isNotEmpty()) {
                put("err", errorMessage)
            }
        } else if (isStream && (responseInline.isNotEmpty() || responseChars > INLINE_MAX)) {
            putBody(this, FIELD_RSP, responseInline, responseChars)
        }
    }

    private fun dropOldestFrame() {
        val victim = pendingFrames.removeAt(0)
        unsentBlobs.removeAll { blob ->
            blob.optString("field") == FIELD_FRAME && blob.optInt("seq") == victim.seq
        }
    }

    private fun enqueueChunks(field: String, text: String, seq: Int = -1, dir: String = "", ts: Long = 0) {
        val count = (text.length + CHUNK_SIZE - 1) / CHUNK_SIZE
        var index = 0
        var offset = 0
        while (offset < text.length) {
            val end = min(offset + CHUNK_SIZE, text.length)
            unsentBlobs.add(JSONObject().apply {
                put("id", callbackId)
                put("field", field)
                put("index", index)
                put("count", count)
                put("data", text.substring(offset, end))
                if (seq >= 0) {
                    put("seq", seq)
                    put("dir", dir)
                    put("ts", ts)
                }
            })
            index++
            offset = end
        }
    }

    private class PendingFrame(
        val seq: Int,
        val dir: String,
        val ts: Long,
        val data: String,
        val dataChars: Int
    )

    companion object {
        const val STACK_KR_NETWORK = "KRNetworkModule"
        const val STACK_TDF_NETWORK = "TDF/network.fetch"
        const val STACK_MAP_SERVER = "TMNetworkModule.fetchMapServer"
        const val STACK_TDF_LONGLINK = "TDF/TMLongLinkModule"
        const val STACK_QMLINK = "TMKuiklyLongLinkModule"
        const val STACK_MQTT = "TMKuiklyMQTTModule"
        const val KIND_STREAM = "stream"
        const val DIR_UP = "up"
        const val DIR_DOWN = "down"
        const val FIELD_REQ = "req"
        const val FIELD_RSP = "rsp"
        const val FIELD_FRAME = "frame"

        private const val MAX_PENDING_FRAMES = 80
        /** Small enough to inline; anything bigger is chunked so one ingest POST stays bridge-safe. */
        internal const val INLINE_MAX = 80_000
        internal const val CHUNK_SIZE = 80_000

        private fun putBody(json: JSONObject, field: String, inline: String, chars: Int) {
            if (inline.isNotEmpty()) {
                json.put(field, inline)
                return
            }
            if (chars > INLINE_MAX) {
                json.put(field + "Chars", chars)
                json.put(field + "Chunks", (chars + CHUNK_SIZE - 1) / CHUNK_SIZE)
            } else if (chars == 0 && field == FIELD_RSP) {
                json.put(field, "")
            }
        }
    }
}
