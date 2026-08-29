package com.ailuoku6.kuikly.devtools

import com.tencent.kuikly.core.manager.BridgeManager
import com.tencent.kuikly.core.pager.Pager

@Suppress("unused")
private val kdtEagerNativeReturnTap: Unit = runCatching { installNativeReturnTap() }.getOrDefault(Unit)

/**
 * Entry point of the Kuikly DevTools agent.
 *
 * Every member here is either called from instrumented business code (see the instrumentor) or from
 * the agent itself. Nothing throws: a DevTools defect must never take the page down.
 */
object KDevtools {

    internal const val TAG = "KuiklyDevtools"

    init {
        // JS: wrap NativeBridge.prototype.toNative (retries if the first eager wrap was too early).
        runCatching { installNativeReturnTap() }
    }

    private val sessions = LinkedHashMap<String, KDevtoolsSession>()

    /**
     * Identity-keyed state dumpers installed by instrumented `init` blocks.
     *
     * Views do not override equals/hashCode, so a plain map gives identity semantics. There is no
     * common-source weak reference in KMP, so entries are dropped wholesale once the last page
     * detaches; in a debug-only build that is an acceptable trade for cross-target portability.
     */
    private val stateDumpers = LinkedHashMap<Any, MutableList<() -> Map<String, Any?>>>()
    private const val MAX_STATE_DUMPERS = 20000

    /**
     * Non-zero while [KDevtoolsTransport] is issuing its own ingest HTTP call.
     *
     * Uploads go through `KRNetworkModule.httpRequest`, which the bridge tap also records. URL-based
     * filtering is the primary guard; this flag is the same reentrancy pattern used for logs.
     */
    private var uploadReentrancy = 0

    // ------------------------------------------------------------------ lifecycle

    /**
     * Called from an `init` block appended to every `@Page` class body.
     *
     * Runs inside the page constructor, i.e. before `PagerManager` has registered the pager, so the
     * sampling loop is only armed later from the first observed bridge call.
     */
    fun attachPager(pager: Pager, className: String) {
        if (!KDevtoolsConfig.ENABLED) return
        try {
            @Suppress("DEPRECATION")
            val pagerId = BridgeManager.currentPageId
            if (pagerId.isEmpty()) {
                agentLog(LEVEL_ERROR, "attachPager($className) skipped: empty pagerId")
                return
            }
            sessions.remove(pagerId)?.detach()
            val session = KDevtoolsSession(pagerId, pager, className)
            sessions[pagerId] = session
            session.attach()
            agentLog(
                LEVEL_INFO,
                "attached $className pagerId=$pagerId -> ${KDevtoolsConfig.HOST}:${KDevtoolsConfig.PORT}"
            )
        } catch (t: Throwable) {
            agentLog(LEVEL_ERROR, "attachPager($className) failed: $t")
        }
    }

    internal fun detachPager(pagerId: String) {
        try {
            sessions.remove(pagerId)?.detach()
            if (sessions.isEmpty()) {
                stateDumpers.clear()
            }
        } catch (t: Throwable) {
            agentLog(LEVEL_ERROR, "detachPager($pagerId) failed: $t")
        }
    }

    // --------------------------------------------------------------- state dumping

    /**
     * Registers a closure that reads the owner's declared properties. The closure is generated inside
     * the owner's own class body, which is what makes `private` members readable without reflection
     * (unavailable on Kotlin/Native and Kotlin/JS).
     */
    fun registerState(owner: Any, dumper: () -> Map<String, Any?>) {
        if (!KDevtoolsConfig.ENABLED) return
        val existing = stateDumpers[owner]
        if (existing != null) {
            // A subclass and each of its instrumented superclasses register separately for the same
            // instance; appending rather than replacing is what keeps inherited fields visible.
            existing.add(dumper)
            return
        }
        if (stateDumpers.size >= MAX_STATE_DUMPERS) return
        stateDumpers[owner] = mutableListOf(dumper)
    }

    /**
     * Reads one property in isolation. Each field gets its own guarded lambda so an uninitialised
     * `lateinit` or a throwing getter only blanks out that single entry.
     */
    fun tryPut(target: MutableMap<String, Any?>, name: String, read: () -> Any?) {
        target[name] = try {
            read()
        } catch (t: Throwable) {
            "$UNREADABLE_PREFIX ${t.message ?: "error"}>"
        }
    }

    internal fun dumpState(owner: Any): Map<String, Any?>? {
        val dumpers = stateDumpers[owner] ?: return null
        // Registration order is superclass first (its init block runs first), so merging in that
        // order lets a subclass that shadows a name win in the merged view.
        val merged = LinkedHashMap<String, Any?>()
        for (dumper in dumpers) {
            try {
                merged.putAll(dumper())
            } catch (t: Throwable) {
                merged["<dump failed>"] = t.message ?: "error"
            }
        }
        return merged
    }

    internal fun hasState(owner: Any): Boolean = stateDumpers.containsKey(owner)

    // ------------------------------------------------------------------- log hooks

    /**
     * Replacement for `println` at instrumented call sites.
     *
     * `println` is the one logging path that never reaches the bridge, so it is the only one that
     * needs a rewritten call site; `TMLog` and `KLog` are captured for free by [KDevtoolsBridgeTap].
     * The original call is always forwarded, so app behaviour is unchanged.
     */
    fun printLine(value: Any?) {
        val text = try {
            value?.toString() ?: "null"
        } catch (t: Throwable) {
            "<toString failed>"
        }
        capture(LEVEL_PRINT, "println", text)
        println(text)
    }

    /** The agent's own logging, kept outside the bridge observer path. */
    internal fun agentLog(level: String, message: String) {
        println(message)
    }

    internal fun beginOwnUpload() {
        uploadReentrancy++
    }

    internal fun endOwnUpload() {
        if (uploadReentrancy > 0) uploadReentrancy--
    }

    internal val isEmittingOwnUpload: Boolean get() = uploadReentrancy > 0

    internal fun capture(level: String, tag: String, message: String) {
        if (!KDevtoolsConfig.ENABLED) return
        try {
            @Suppress("DEPRECATION")
            val current = BridgeManager.currentPageId
            // Outside a pager context there is no pagerId to route by; with a single attached page
            // that is unambiguous, and with several the entry is dropped rather than misfiled.
            val session = sessions[current] ?: soleSession() ?: return
            session.onLog(level, tag, message)
        } catch (_: Throwable) {
            // Swallow: capturing a log must never be able to break the page.
        }
    }

    private fun soleSession(): KDevtoolsSession? =
        if (sessions.size == 1) sessions.values.first() else null

    internal const val LEVEL_INFO = "i"
    internal const val LEVEL_DEBUG = "d"
    internal const val LEVEL_ERROR = "e"
    internal const val LEVEL_PRINT = "p"

    /** Panel-visible marker for a property that could not be read. */
    private const val UNREADABLE_PREFIX = "<unreadable:"
}
