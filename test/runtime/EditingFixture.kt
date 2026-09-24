package com.ailuoku6.kuikly.devtools

import com.tencent.kuikly.core.base.*
import com.tencent.kuikly.core.nvi.serialization.json.JSONObject
import com.tencent.kuikly.core.reactive.handler.observable

// Copied and instrumented by runtime-editing.py. Exercise generated setters against real Kuikly.
class EditingPager : PagerBase() {
    private var accent = Color(0xFFFF0000L)
    var count: Int by observable(1)
    val readOnly = 7
    var optional: String? = null
    var setterCalls = 0
    var custom = 0
        set(value) { field = value; setterCalls++ }
}

open class PagerBase : com.tencent.kuikly.core.pager.Pager() {
    var layouts = 0
    override fun body(): ViewBuilder = {}
    override fun onCreatePager(pagerId: String, pageData: JSONObject) { this.pagerId = pagerId }
    override fun onLayoutView() { layouts++ }
}
