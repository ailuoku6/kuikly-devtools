package com.ailuoku6.kuikly.devtools

import com.tencent.kuikly.core.nvi.serialization.json.JSONArray
import com.tencent.kuikly.core.nvi.serialization.json.JSONObject
import kotlin.math.min

/**
 * One captured Kotlin → Native module call (`CALL_MODULE_METHOD` / `CALL_TDF_MODULE_METHOD`).
 *
 * Async returns arrive later as `FIRE_CALLBACK`. Sync returns are filled by tapping
 * `NativeBridge.toNative` after the call (the observer itself fires before). Keep-alive
 * callbacks (Notify / vsync-style) promote the row to `kind: stream`.
 */
internal class NativeCallRecord(
    val id: String,
    private val moduleName: String,
    private val methodName: String,
    private val via: String,
    val sync: Boolean,
    args: String,
    private val startedAt: Long
) {
    private val argsInline: String
    private val argsChars: Int
    private var finishedAt: Long = 0
    private var success: Boolean = false
    private var errorMessage: String = ""
    private var responseInline: String = ""
    private var responseChars: Int = 0
    private var stream = false
    private var frameSeq = 0
    private val pendingFrames = ArrayList<PendingFrame>()
    private var frameCount = 0
    private val unsentBlobs = ArrayList<JSONObject>()
    private var drainCount = 0

    var dirty: Boolean = true
        private set

    val isOpen: Boolean get() = finishedAt == 0L

    init {
        if (args.length <= INLINE_MAX) {
            argsInline = args
            argsChars = args.length
        } else {
            argsInline = ""
            argsChars = args.length
            enqueueChunks(FIELD_ARGS, args)
        }
    }

    fun needsUpload(): Boolean = dirty || unsentBlobs.isNotEmpty()

    fun hasUnsentBlobs(): Boolean = unsentBlobs.isNotEmpty()

    fun snapshotBlobs(): List<JSONObject> = ArrayList(unsentBlobs)

    /**
     * First payload completes the row. A later callback on the same id means keep-alive: promote
     * to a stream and append frames so NotifyModule (and similar) stay inspectable.
     */
    fun complete(ok: Boolean, error: String, body: String, at: Long) {
        if (finishedAt > 0) {
            if (!stream) {
                stream = true
                if (responseInline.isNotEmpty() || responseChars > 0) {
                    prependFrame(NetworkRecord.DIR_DOWN, responseInline, finishedAt, responseChars)
                }
            }
            addFrame(NetworkRecord.DIR_DOWN, body, at)
            success = ok
            if (error.isNotEmpty()) errorMessage = error
            return
        }
        finishedAt = at
        success = ok
        errorMessage = error
        setResponse(body)
        dirty = true
    }

    /**
     * Fills the immediate return of a sync `toNative`. Must not promote the row to a stream: a
     * later `FIRE_CALLBACK` still uses [complete] for keep-alive.
     */
    fun fillSyncReturn(body: String, at: Long) {
        if (stream) {
            addFrame(NetworkRecord.DIR_DOWN, body, at)
            return
        }
        if (finishedAt == 0L) {
            complete(true, "", body, at)
            return
        }
        success = true
        setResponse(body)
        finishedAt = at
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
        setResponse(data)
        dirty = true
    }

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

    fun toJson(): JSONObject = JSONObject().apply {
        put("id", id)
        put("mod", moduleName)
        put("method", methodName)
        put("via", via)
        put("sync", sync)
        putBody(this, FIELD_ARGS, argsInline, argsChars)
        put("ts", startedAt)
        if (stream) {
            put("kind", NetworkRecord.KIND_STREAM)
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
            put("ok", success)
            putBody(this, FIELD_RSP, responseInline, responseChars)
            if (errorMessage.isNotEmpty()) put("err", errorMessage)
        }
    }

    private fun setResponse(body: String) {
        if (body.length <= INLINE_MAX) {
            responseInline = body
            responseChars = body.length
        } else {
            responseInline = ""
            responseChars = body.length
            enqueueChunks(FIELD_RSP, body)
        }
    }

    private fun prependFrame(dir: String, data: String, at: Long, chars: Int) {
        val seq = frameSeq++
        if (data.isNotEmpty() && data.length <= INLINE_MAX) {
            pendingFrames.add(0, PendingFrame(seq, dir, at, data, 0))
        } else {
            pendingFrames.add(0, PendingFrame(seq, dir, at, "", if (chars > 0) chars else data.length))
        }
        frameCount++
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
                put("id", id)
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
        const val FIELD_ARGS = "args"
        const val FIELD_RSP = "rsp"
        const val FIELD_FRAME = "frame"
        private const val MAX_PENDING_FRAMES = 80
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
