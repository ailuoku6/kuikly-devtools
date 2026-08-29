package com.ailuoku6.kuikly.devtools

import com.tencent.kuikly.core.nvi.NativeBridge

/**
 * Kotlin/JS (`npx kuikly-devtools build-js`) 的同步返回必须拦在
 * `NativeBridge.prototype.toNative` 上。
 *
 * 包 `registerCallNative` 接不住：
 *  - 模块末尾 `$jsExportAll$` / UMD 会把原始函数写回 `com.tencent.kuikly.core.nvi`
 *  - 实例字段 `callNativeCallback` 第一次 `toNative` 才从 map 懒加载，提前包会丢掉原回调
 *  - 旧宿主走全局 `callNative`，根本不经过 `registerCallNative`
 *
 * `CalendarModule.get` 等 klib 内部调用也走这个 prototype 方法。
 */
private var protoWrapped = false

@Suppress("unused")
private val eagerInstall: Boolean = run {
    installNativeReturnTap()
    true
}

internal actual fun installNativeReturnTap() {
    if (protoWrapped) return
    try {
        wrapToNative(NativeBridge())
    } catch (_: Throwable) {
    }
}

internal actual fun wrapNativeBridge(bridge: NativeBridge) {
    wrapToNative(bridge)
}

internal actual fun nativeBridgeForPager(pagerId: String): NativeBridge? {
    return try {
        val dyn = com.tencent.kuikly.core.manager.BridgeManager.asDynamic()
        val map = dyn.nativeBridgeMap ?: dyn.nativeBridgeMap_1 ?: dyn._nativeBridgeMap
        if (map == null) null else map[pagerId] as? NativeBridge
    } catch (_: Throwable) {
        null
    }
}

private fun wrapToNative(bridge: NativeBridge) {
    if (protoWrapped) return
    try {
        val notify: dynamic = { methodId: dynamic, result: dynamic ->
            try {
                KDevtoolsNativeReturn.onToNativeReturn(toMethodId(methodId), result)
            } catch (_: Throwable) {
            }
        }
        if (patchToNative(bridge.asDynamic(), notify)) {
            protoWrapped = true
        }
    } catch (_: Throwable) {
    }
}

/**
 * Replace the mangled `toNative_*` with a raw JS function so `this` stays the NativeBridge
 * instance. Kotlin lambdas would drop `this` and the lazy callback would never load.
 */
private fun patchToNative(target: dynamic, notify: dynamic): Boolean {
    return js(
        """
        (function() {
            if (target == null) return false;
            var cursor = target;
            var name = null;
            var owner = null;
            while (cursor && cursor !== Object.prototype) {
                if (cursor.__kdtToNative === true) return true;
                var names = Object.getOwnPropertyNames(cursor);
                for (var i = 0; i < names.length; i++) {
                    var n = names[i];
                    if (typeof cursor[n] === 'function' && n.indexOf('toNative') === 0 && n.indexOf('default') < 0) {
                        name = n;
                        owner = cursor;
                        break;
                    }
                }
                if (name) break;
                cursor = Object.getPrototypeOf(cursor);
            }
            if (!name || !owner) return false;
            var orig = owner[name];
            owner[name] = function(methodId, arg0, arg1, arg2, arg3, arg4, arg5) {
                var result = orig.call(this, methodId, arg0, arg1, arg2, arg3, arg4, arg5);
                try { notify(methodId, result); } catch (e) {}
                return result;
            };
            owner.__kdtToNative = true;
            return true;
        })()
        """
    ) == true
}

private fun toMethodId(methodId: dynamic): Int = when (methodId) {
    is Int -> methodId
    is Number -> methodId.toInt()
    else -> 0
}
