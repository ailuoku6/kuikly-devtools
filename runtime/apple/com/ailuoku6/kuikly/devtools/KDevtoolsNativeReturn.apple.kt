package com.ailuoku6.kuikly.devtools

import com.tencent.kuikly.core.nvi.NativeBridge

internal actual fun installNativeReturnTap() {
}

internal actual fun wrapNativeBridge(bridge: NativeBridge) {
    val original = bridge.iosNativeBridgeDelegate
    if (original is TappingIosDelegate) return
    bridge.iosNativeBridgeDelegate = TappingIosDelegate(original)
}

internal actual fun nativeBridgeForPager(pagerId: String): NativeBridge? = null

private class TappingIosDelegate(
    private val inner: NativeBridge.IOSNativeBridgeDelegate?
) : NativeBridge.IOSNativeBridgeDelegate {
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
