package com.ailuoku6.kuikly.devtools

import com.tencent.kuikly.core.nvi.serialization.json.JSONArray
import com.tencent.kuikly.core.nvi.serialization.json.JSONObject

/**
 * Value coercion for anything we ship to the DevTools server.
 *
 * Kuikly's [JSONObject.put] accepts `Any?` without validating, so an unsupported value would only
 * blow up later inside `toString()`. Everything is therefore narrowed to a JSON-safe type up front.
 */
internal object KDevtoolsJson {

    private const val MAX_DEPTH = 4
    private const val MAX_COLLECTION = 60
    private const val MAX_STRING = 2000

    fun encode(value: Any?, depth: Int = 0): Any? = when (value) {
        null -> null
        is String -> clamp(value)
        is Int, is Long, is Boolean, is Double -> value
        is Float -> value.toDouble()
        is Short -> value.toInt()
        is Byte -> value.toInt()
        is Char -> value.toString()
        is JSONObject -> if (depth >= MAX_DEPTH) clamp(value.toString()) else value
        is JSONArray -> if (depth >= MAX_DEPTH) clamp(value.toString()) else value
        is Map<*, *> -> encodeMap(value, depth)
        is Iterable<*> -> encodeIterable(value, depth)
        else -> clamp(safeToString(value))
    }

    fun objectOf(source: Map<*, *>): JSONObject = encodeMap(source, 0)

    private fun encodeMap(source: Map<*, *>, depth: Int): JSONObject {
        val json = JSONObject()
        if (depth >= MAX_DEPTH) return json
        // HashMap iteration order jumps when a single prop changes; sort so the wire form and the
        // inspector stay stable (and so tree diffs do not fire on key-order noise).
        val entries = ArrayList<Pair<String, Any?>>(source.size)
        for ((key, value) in source) {
            entries.add((key?.toString() ?: "null") to value)
        }
        entries.sortBy { it.first }
        var count = 0
        for ((key, value) in entries) {
            if (count >= MAX_COLLECTION) {
                json.put("…", "${source.size - MAX_COLLECTION} more")
                break
            }
            json.put(key, encodeProp(key, value, depth + 1))
            count++
        }
        return json
    }

    /**
     * Kuikly [com.tencent.kuikly.core.base.Color] is a signed ARGB Int. Alpha ≥ 0x80 makes
     * `toString()` look like `-14101165`. Colour props are emitted as `0xAARRGGBB`.
     */
    private fun encodeProp(key: String, value: Any?, depth: Int): Any? {
        if (isColorKey(key)) {
            argbHex(value)?.let { return it }
        }
        return encode(value, depth)
    }

    private fun isColorKey(key: String): Boolean {
        val lower = key.lowercase()
        return lower.contains("color") || lower.contains("tint")
    }

    private fun argbHex(value: Any?): String? {
        val bits = colorBits(value) ?: return null
        val hex = bits.toString(16).uppercase()
        return "0x" + hex.padStart(8, '0')
    }

    private fun colorBits(value: Any?): Long? {
        when (value) {
            null -> return null
            is Int -> return value.toLong() and 0xFFFFFFFFL
            is Long -> return value and 0xFFFFFFFFL
            is Double -> {
                if (value % 1.0 != 0.0) return null
                return value.toLong() and 0xFFFFFFFFL
            }
            is Float -> {
                if (value % 1f != 0f) return null
                return value.toLong() and 0xFFFFFFFFL
            }
            is String -> {
                val text = value.trim()
                if (text.startsWith("0x") || text.startsWith("0X")) {
                    return text.substring(2).toLongOrNull(16)?.and(0xFFFFFFFFL)
                }
                if (text.startsWith("#") && (text.length == 7 || text.length == 9)) {
                    val body = if (text.length == 7) "FF" + text.substring(1) else text.substring(1)
                    return body.toLongOrNull(16)?.and(0xFFFFFFFFL)
                }
                return text.toLongOrNull()?.and(0xFFFFFFFFL)
            }
            else -> {
                val text = try {
                    value.toString()
                } catch (t: Throwable) {
                    return null
                }
                return colorBits(text)
            }
        }
    }

    private fun encodeIterable(source: Iterable<*>, depth: Int): JSONArray {
        val json = JSONArray()
        if (depth >= MAX_DEPTH) return json
        var count = 0
        for (value in source) {
            if (count >= MAX_COLLECTION) {
                json.put("…more")
                break
            }
            json.put(encode(value, depth + 1))
            count++
        }
        return json
    }

    private fun clamp(text: String): String =
        if (text.length <= MAX_STRING) text else text.substring(0, MAX_STRING) + "…"

    private fun safeToString(value: Any): String = try {
        value.toString()
    } catch (t: Throwable) {
        "<toString failed: ${t.message}>"
    }
}
