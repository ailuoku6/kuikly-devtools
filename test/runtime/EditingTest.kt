package com.ailuoku6.kuikly.devtools

import com.tencent.kuikly.core.base.Color
import com.tencent.kuikly.core.manager.BridgeManager
import com.tencent.kuikly.core.manager.PagerManager
import com.tencent.kuikly.core.nvi.serialization.json.JSONObject

private fun fails(block: () -> Unit) { check(runCatching(block).isFailure) }

fun main() {
    BridgeManager.currentPageId = "edit-test"
    PagerManager.registerPageRouter("EditingPager") { EditingPager() }
    PagerManager.createPager("edit-test", "EditingPager", "{}")
    val pager = PagerManager.getPager("edit-test") as EditingPager
    var observed = 0
    pager.bindValueChange({ pager.count }) { observed = it as Int }
    KDevtools.editState(pager, "count", 5)
    check(pager.count == 5 && observed == 5) { "Observable setter did not notify" }
    KDevtools.editState(pager, "accent", 2148606515L)
    check((KDevtools.dumpState(pager)!!["accent"] as Color).toString() == "2148606515")
    KDevtools.editState(pager, "custom", 12)
    check(pager.custom == 12 && pager.setterCalls == 1)
    KDevtools.editState(pager, "optional", "value")
    KDevtools.editState(pager, "optional", null)
    check(pager.optional == null)
    fails { KDevtools.editState(pager, "readOnly", 8) }
    fails { KDevtools.editState(pager, "count", 1.5) }
    fails { KDevtools.editState(pager, "count", null) }
    check(pager.count == 5)
    check(coerceEdit(1f, 2.5) == 2.5f)
    check(coerceEdit(1L, 123) == 123L)
    check(coerceEdit('a', "b") == 'b')
    fails { coerceEdit(1.toByte(), 128) }
    fails { coerceEdit(1, 2147483648L) }
    fails { coerceEdit(1f, 1e40) }
    fails { coerceEdit(false, "true") }
    check(coerceEdit(Color.BLACK, "theme-primary").toString() == "theme-primary")

    val attr = pager.getViewAttr()
    attr.backgroundColor(Color.RED)
    attr.width(100f)
    attr.margin(2f)
    editProp(pager, "backgroundColor", "2148606515")
    check(attr.getProp("backgroundColor") == "2148606515")
    editProp(pager, "width", 150)
    check(pager.flexNode.styleWidth == 150f && pager.layouts > 0)
    editProp(pager, "margin", JSONObject("{\"top\":10,\"right\":5}"))
    check(collectViewProps(pager, attr)["margin"] == mapOf("top" to 10.0, "right" to 5.0))
    fails { editProp(pager, "width", "oops") }
    check(pager.flexNode.styleWidth == 150f)
    fails { editProp(pager, "unknown", 1) }

    val tree = KDevtoolsTree(pager)
    val ids = setOf(pager.nativeRef)
    check(tree.collect(true, ids).nodes.length() == 1)
    val idle = tree.collect(false, ids)
    check(idle.changed == 0) { "Reading state should not dirty a live frame" }
    val shot = tree.collect(false, ids, includeAll = true)
    check(shot.nodes.length() == 1 && shot.changed == 0) { "Screenshot tree must include unchanged nodes without forcing another capture" }
    val root = shot.nodes.optJSONObject(0)!!
    check(root.optJSONObject("p")!!.optString("backgroundColor") == "2148606515") { "Runtime must send raw colors" }
    check(root.optJSONObject("e")!!.optJSONObject("s")!!.optString("accent") == "Color")
    check(!root.optJSONObject("e")!!.optJSONObject("s")!!.has("readOnly"))
    KDevtools.editState(pager, "count", 6)
    check(tree.collect(false, ids).changed == 1)

    // Exercise command dispatch and device result reporting, including a deleted/stale node.
    val session = KDevtoolsSession("edit-test", pager, "EditingPager")
    val apply = session.javaClass.getDeclaredMethod("applyEdit", JSONObject::class.java).apply { isAccessible = true }
    apply.invoke(session, JSONObject().apply {
        put("requestId", "ok"); put("id", pager.nativeRef); put("target", "s"); put("key", "count"); put("value", 9)
    })
    apply.invoke(session, JSONObject().apply {
        put("requestId", "bad"); put("id", -999); put("target", "s"); put("key", "count"); put("value", 10)
    })
    @Suppress("UNCHECKED_CAST")
    val results = session.javaClass.getDeclaredField("editResults").apply { isAccessible = true }.get(session) as List<JSONObject>
    check(pager.count == 9 && results[0].optBoolean("ok"))
    check(!results[1].optBoolean("ok") && results[1].optString("error").isNotEmpty())
    // Reproduce asynchronous ingest on every tick after editing subscribes to state.
    // The old scheduler only pumped immediately after starting upload, so it always skipped.
    val uploads = ArrayList<JSONObject>()
    var completeUpload: ((Boolean, com.tencent.kuikly.core.nvi.serialization.json.JSONArray?) -> Unit)? = null
    val liveSession = KDevtoolsSession("edit-test", pager, "EditingPager") { payload, done ->
        uploads.add(payload)
        completeUpload = done
    }
    fun field(name: String) = liveSession.javaClass.getDeclaredField(name).apply { isAccessible = true }
    fun invoke(name: String) = liveSession.javaClass.getDeclaredMethod(name).apply { isAccessible = true }.invoke(liveSession)
    field("liveShot").set(liveSession, true)
    val edit = liveSession.javaClass.getDeclaredMethod("applyEdit", JSONObject::class.java).apply { isAccessible = true }
    repeat(2) { index ->
        // Simulate completion of the preceding native capture and elapsed rate limit.
        field("screenshotInFlight").set(liveSession, false)
        field("lastLiveShotAt").set(liveSession, 0L)
        edit.invoke(liveSession, JSONObject().apply {
            put("requestId", "live-$index"); put("id", pager.nativeRef); put("target", "p")
            put("key", "width"); put("value", 180 + index)
        })
        invoke("upload")
        invoke("pumpLiveShot")
        check(!field("screenshotInFlight").getBoolean(liveSession))
        check(uploads.last().optJSONObject("tree")!!.optJSONArray("nodes")!!.length() == 1)
        completeUpload!!(true, null)
        check(field("screenshotInFlight").getBoolean(liveSession)) { "Live screenshot starved by continuous state uploads" }
    }
    // An upload finishing after live is paused must not restart capture.
    field("screenshotInFlight").set(liveSession, false)
    field("liveShot").set(liveSession, false)
    field("liveNeedsFrame").set(liveSession, true)
    invoke("upload")
    completeUpload!!(true, null)
    check(!field("screenshotInFlight").getBoolean(liveSession))
    // Absent Attr fields use typed setters and never depend on an old value's type.
    val textView = com.tencent.kuikly.core.views.TextView().apply {
        pagerId = "edit-test"
        didMoveToParentView()
        willInit()
        createFlexNode()
        createRenderView()
    }
    val registry = KDevtoolsPropSchema("test-session")
    val schema = registry.query(textView)
    val token = schema.optString("schemaToken")
    check(!collectViewProps(textView, textView.getViewAttr()).containsKey("backgroundColor"))
    check(schema.optJSONArray("properties")!!.length() > 20)
    val colorRead = registry.set(textView, token, "backgroundColor", 2148606515L)
    check(colorRead.optString("value") == "2148606515")
    check(textView.getViewAttr().getProp("backgroundColor") is String)
    registry.set(textView, token, "visibility", false)
    check(textView.getViewAttr().getProp("visibility") == 0)
    check(readSupportedProp(textView, "visibility") == false)
    registry.set(textView, token, "touchEnable", true)
    check(textView.getViewAttr().getProp("touchEnable") == 1)
    registry.set(textView, token, "text", "AI added text")
    check(textView.getViewAttr().getProp("text") == "AI added text")
    val beforeLayouts = pager.layouts
    registry.set(textView, token, "fontSize", 24)
    check(textView.getViewAttr().getProp("fontSize") == 24f && pager.layouts > beforeLayouts)
    registry.set(textView, token, "padding", 4)
    fails { registry.set(textView, token, "padding", JSONObject("{\"top\":8,\"right\":-1}")) }
    check(readSupportedProp(textView, "padding") == 4.0)
    fails { registry.set(textView, token, "padding", JSONObject("{\"unknown\":1}")) }
    fails { registry.set(textView, token, "backgroundColor", "#FFFFFF") }
    fails { registry.set(textView, token, "backgroundColor", 4294967296L) }
    fails { registry.set(textView, token, "opacity", 1.1) }
    fails { registry.set(textView, token, "fontSize", 0) }
    fails { registry.set(textView, token, "visibility", 1) }
    fails { registry.set(textView, token, "width", 1e40) }
    fails { registry.set(textView, token, "padding", JSONObject("{\"top\":null}")) }
    registry.set(textView, token, "width", 1e10)
    check(readSupportedProp(textView, "width") == 1e10) { "Readback must not overflow the tree's two-decimal display rounding" }
    registry.set(textView, token, "minWidth", 10)
    fails { registry.set(textView, token, "maxWidth", 9) }
    registry.set(textView, token, "flex", 0)
    registry.set(textView, token, "margin", 0)
    val supplemented = collectViewProps(textView, textView.getViewAttr()).toMutableMap()
    check(!supplemented.containsKey("margin"))
    registry.supplement(textView, supplemented)
    check(supplemented["margin"] == 0.0 && supplemented["flex"] == 0.0)
    textView.getViewAttr().margin(5f)
    registry.supplement(textView, supplemented)
    check(supplemented["margin"] == 5.0) { "Touched props must re-read business changes" }
    fails { registry.set(textView, token, "madeUpProperty", 1) }
    val otherRegistry = KDevtoolsPropSchema("new-session")
    otherRegistry.query(textView)
    fails { otherRegistry.set(textView, token, "opacity", 0.5) }
    registry.prune(emptySet())
    fails { registry.set(textView, token, "opacity", 0.5) }
    val newToken = registry.query(textView).optString("schemaToken")
    check(newToken != token)
    val queryMethod = session.javaClass.getDeclaredMethod("inspectProps", JSONObject::class.java).apply { isAccessible = true }
    queryMethod.invoke(session, JSONObject().apply { put("id", textView.nativeRef); put("requestId", "schema-query") })
    @Suppress("UNCHECKED_CAST")
    val queried = session.javaClass.getDeclaredField("propSchemaResults").apply { isAccessible = true }.get(session) as List<JSONObject>
    val sessionToken = queried.last().optString("schemaToken")
    check(queried.last().optBoolean("ok") && sessionToken.isNotEmpty())
    apply.invoke(session, JSONObject().apply {
        put("requestId", "supported-command"); put("id", textView.nativeRef); put("target", "p")
        put("mode", "setSupported"); put("schemaToken", sessionToken); put("key", "opacity"); put("value", 0.5)
    })
    check(results.last().optBoolean("ok") && results.last().optJSONObject("readback")!!.optDouble("value") == 0.5)
    apply.invoke(session, JSONObject().apply {
        put("requestId", "expired-command"); put("id", textView.nativeRef); put("target", "p")
        put("mode", "setSupported"); put("schemaToken", "old"); put("key", "opacity"); put("value", 0.2)
    })
    check(!results.last().optBoolean("ok") && results.last().optString("code") == "SCHEMA_EXPIRED")
    check(textView.getViewAttr().getProp("opacity") == 0.5f)
    textView.removeRenderView()
    fails { registry.set(textView, newToken, "opacity", 0.5) }
    check(registry.query(textView).optJSONArray("properties")!!.length() == 0)
    println("runtime-editing: ok (real Kuikly JVM, generated setters, observable updates, Color, layout, screenshot tree)")
}
