package com.ailuoku6.kuikly.devtools

import com.tencent.kuikly.core.nvi.NativeBridge

internal actual fun installNativeReturnTap() {
}

internal actual fun wrapNativeBridge(bridge: NativeBridge) {
    val original = bridge.delegate
    if (original is TappingNativeDelegate) return
    bridge.delegate = TappingNativeDelegate(original)
}

internal actual fun nativeBridgeForPager(pagerId: String): NativeBridge? {
    return try {
        val clazz = Class.forName("com.tencent.kuikly.core.manager.BridgeManager")
        val instance = try {
            clazz.getField("INSTANCE").get(null)
        } catch (_: Throwable) {
            val field = clazz.getDeclaredField("INSTANCE")
            field.isAccessible = true
            field.get(null)
        }
        val mapField = clazz.declaredFields.firstOrNull { it.name.contains("nativeBridgeMap") } ?: return null
        mapField.isAccessible = true
        val map = mapField.get(instance) as? Map<*, *> ?: return null
        map[pagerId] as? NativeBridge
    } catch (_: Throwable) {
        null
    }
}

private class TappingNativeDelegate(
    private val inner: NativeBridge.NativeBridgeDelegate?
) : NativeBridge.NativeBridgeDelegate {
    override fun callNative(
        methodId: Int,
        arg0: Any?,
        arg1: Any?,
        arg2: Any?,
        arg3: Any?,
        arg4: Any?,
        arg5: Any?
    ): Any? {
        val result = inner?.callNative(methodId, arg0, arg1, arg2, arg3, arg4, arg5)
        KDevtoolsNativeReturn.onToNativeReturn(methodId, result)
        return result
    }
}
