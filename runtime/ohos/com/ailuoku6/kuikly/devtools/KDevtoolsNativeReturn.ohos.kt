package com.ailuoku6.kuikly.devtools

import com.tencent.kuikly.core.nvi.NativeBridge

internal actual fun installNativeReturnTap() {
}

internal actual fun wrapNativeBridge(bridge: NativeBridge) {
    val original = bridge.callNativeCallback
    bridge.callNativeCallback = { methodId, arg0, arg1, arg2, arg3, arg4, arg5 ->
        val result = original?.invoke(methodId, arg0, arg1, arg2, arg3, arg4, arg5)
        KDevtoolsNativeReturn.onToNativeReturn(methodId, result)
        result
    }
}

internal actual fun nativeBridgeForPager(pagerId: String): NativeBridge? = null
