package com.ailuoku6.kuikly.devtools

import com.tencent.kuikly.core.datetime.DateTime
import com.tencent.kuikly.core.manager.NativeMethod
import com.tencent.kuikly.core.module.Module
import com.tencent.kuikly.core.nvi.NativeBridge
import com.tencent.kuikly.core.nvi.serialization.json.JSONArray
import com.tencent.kuikly.core.nvi.serialization.json.JSONObject

/**
 * Fills sync Native Calls rows after `NativeBridge.toNative` returns.
 *
 * `IBridgeCallObserver.onCallNative` runs *before* that call, so it never sees a result.
 * Every Kotlin → Native invoke (app `syncCall`, official `CalendarModule.get`, klib internals)
 * goes through `toNative`; tapping that one return is the unified hook.
 */
internal object KDevtoolsNativeReturn {

    private val pendingSync = ArrayList<NativeCallRecord>()
    private val tapped = ArrayList<NativeBridge>()

    fun install(bridge: NativeBridge) {
        if (tapped.any { it === bridge }) return
        try {
            wrapNativeBridge(bridge)
            tapped.add(bridge)
        } catch (_: Throwable) {
        }
    }

    fun installForPager(pagerId: String) {
        try {
            installNativeReturnTap()
        } catch (_: Throwable) {
        }
        if (pagerId.isEmpty()) return
        try {
            nativeBridgeForPager(pagerId)?.let { install(it) }
        } catch (_: Throwable) {
        }
    }

    fun pushSync(record: NativeCallRecord) {
        if (pendingSync.size >= MAX_PENDING) pendingSync.removeAt(0)
        pendingSync.add(record)
    }

    fun onToNativeReturn(methodId: Int, result: Any?) {
        if (methodId != NativeMethod.CALL_MODULE_METHOD && methodId != NativeMethod.CALL_TDF_MODULE_METHOD) {
            return
        }
        completePending(result)
    }

    private fun completePending(value: Any?) {
        if (pendingSync.isEmpty()) return
        if (KDevtools.isEmittingOwnUpload) {
            pendingSync.removeAt(pendingSync.lastIndex)
            return
        }
        val record = pendingSync.removeAt(pendingSync.lastIndex)
        try {
            val payload = (value as? Module.ReturnValue)?.returnValue ?: value
            record.fillSyncReturn(stringifyReturn(payload), DateTime.currentTimestamp())
        } catch (_: Throwable) {
        }
    }

    private fun stringifyReturn(value: Any?): String {
        val unwrapped = unwrapTdfResult(value)
        return when (unwrapped) {
            null -> "null"
            is String -> unwrapped
            is JSONObject -> unwrapped.toString()
            is JSONArray -> unwrapped.toString()
            is Boolean, is Number -> unwrapped.toString()
            is ByteArray -> {
                val text = try {
                    unwrapped.decodeToString()
                } catch (t: Throwable) {
                    ""
                }
                if (text.isNotEmpty() && (text.first() == '{' || text.first() == '[')) text
                else "<byte[${unwrapped.size}]>"
            }
            else -> unwrapped.toString()
        }
    }

    private fun unwrapTdfResult(value: Any?): Any? {
        val json = when (value) {
            is JSONObject -> value
            is String -> {
                val trimmed = value.trim()
                if (trimmed.startsWith("{")) {
                    try {
                        JSONObject(trimmed)
                    } catch (t: Throwable) {
                        return value
                    }
                } else {
                    return value
                }
            }
            else -> return value
        }
        if (!json.has("result")) return value
        return json.opt("result") ?: value
    }

    private const val MAX_PENDING = 32
}

/** Platform hook: wrap `NativeBridge.toNative`'s return. JS patches the prototype method. */
internal expect fun installNativeReturnTap()

internal expect fun wrapNativeBridge(bridge: NativeBridge)

internal expect fun nativeBridgeForPager(pagerId: String): NativeBridge?
