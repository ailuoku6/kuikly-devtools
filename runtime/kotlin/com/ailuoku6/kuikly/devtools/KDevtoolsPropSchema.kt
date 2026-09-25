package com.ailuoku6.kuikly.devtools

import com.tencent.kuikly.core.base.Color
import com.tencent.kuikly.core.base.DeclarativeBaseView
import com.tencent.kuikly.core.base.isVirtualView
import com.tencent.kuikly.core.nvi.serialization.json.JSONArray
import com.tencent.kuikly.core.nvi.serialization.json.JSONObject
import com.tencent.kuikly.core.views.TextAttr

internal class PropEditException(val code: String, message: String) : IllegalArgumentException(message)

/** Definitions describe semantic inputs, not the types stored in Attr.propsMap. */
internal data class PropDefinition(
    val key: String, val inputType: String, val wireType: String,
    val group: String, val description: String, val min: Double? = null,
    val max: Double? = null, val exclusiveMin: Boolean = false,
    val enumValues: List<String> = emptyList()
) {
    fun json(reportedProps: Map<String, Any>, actualProps: Map<String, Any>): JSONObject = JSONObject().apply {
        put("key", key); put("inputType", inputType); put("wireType", wireType)
        put("group", group); put("description", description)
        min?.let { put("min", it) }; max?.let { put("max", it) }
        if (exclusiveMin) put("exclusiveMin", true)
        if (enumValues.isNotEmpty()) put("enumValues", JSONArray().apply { enumValues.forEach { put(it) } })
        put("reported", reportedProps.containsKey(key))
        val value = semanticPropValue(key, actualProps[key])
        put("readable", value != null)
        if (value != null) put("currentValue", KDevtoolsJson.encode(value))
        if (inputType == "color") put("examples", JSONArray().put("#80C8FF").put("0xFF80C8FF"))
    }
}

private val dimensionKeys = setOf("width", "height", "minWidth", "minHeight", "maxWidth", "maxHeight")
private val baseDefinitions = listOf(
    PropDefinition("backgroundColor", "color", "argb32", "基础外观", "#RRGGBB、#AARRGGBB、0xAARRGGBB 或整数；前两位为透明度，不支持主题 token"),
    PropDefinition("opacity", "number", "Float", "基础外观", "透明度：0–1", 0.0, 1.0),
    PropDefinition("visibility", "boolean", "Boolean", "基础外观", "true / false"),
    PropDefinition("touchEnable", "boolean", "Boolean", "基础外观", "true / false")
) + layoutNumbers.map {
    PropDefinition(it, "number", "Float", "布局", if (it in dimensionKeys) "非负有限数值，min 不得大于 max" else "有限数值，可为负数", if (it in dimensionKeys) 0.0 else null)
} + listOf("margin", "padding").map {
    PropDefinition(it, "space", "space", "布局", "单个数值或 {\"top\":10,\"right\":5}；省略的边为 0" + if (it == "padding") "；不得为负" else "；可为负数", if (it == "padding") 0.0 else null)
} + layoutEnums.map { (key, values) ->
    PropDefinition(key, "enum", "String", "布局", "可选值：${values.joinToString("、")}", enumValues = values)
}
private val textDefinitions = listOf(
    PropDefinition("text", "string", "String", "文本", "文本内容，最多 2000 字符"),
    PropDefinition("color", "color", "argb32", "文本", "#RRGGBB、#AARRGGBB、0xAARRGGBB 或整数；不支持主题 token"),
    PropDefinition("fontSize", "number", "Float", "文本", "正有限数值；输入逻辑字号，回读可能受宿主字体缩放影响", 0.0, exclusiveMin = true)
)

internal fun supportedProps(view: DeclarativeBaseView<*, *>): List<PropDefinition> {
    if (view.isVirtualView() || view.renderView == null) return emptyList()
    return baseDefinitions + if (view.getViewAttr() is TextAttr) textDefinitions else emptyList()
}

internal fun readSupportedProp(view: DeclarativeBaseView<*, *>, key: String): Any? {
    return semanticPropValue(key, collectViewProps(view, view.getViewAttr(), includeDefaults = true)[key])
}

private fun semanticPropValue(key: String, value: Any?): Any? =
    if (key == "visibility" || key == "touchEnable") (value as? Number)?.toInt()?.let { it != 0 } else value

/** Per-session tokens bind an id to object identity, never just a recycled nativeRef. */
internal class KDevtoolsPropSchema(private val sessionId: String) {
    private class Entry(val view: DeclarativeBaseView<*, *>, val token: String, val touched: MutableSet<String> = HashSet())
    private val entries = HashMap<Int, Entry>()
    private var serial = 0
    private fun entry(view: DeclarativeBaseView<*, *>): Entry {
        val current = entries[view.nativeRef]
        if (current != null && current.view === view) return current
        return Entry(view, "$sessionId:props1:${++serial}").also { entries[view.nativeRef] = it }
    }
    fun prune(alive: Set<Int>) { entries.keys.filter { it !in alive }.forEach { entries.remove(it) } }
    fun clear() { entries.clear() }
    fun query(view: DeclarativeBaseView<*, *>): JSONObject = JSONObject().apply {
        put("id", view.nativeRef); put("schemaVersion", 1); put("schemaToken", entry(view).token)
        val definitions = supportedProps(view)
        val reported = collectViewProps(view, view.getViewAttr()).toMutableMap()
        supplement(view, reported)
        val actual = collectViewProps(view, view.getViewAttr(), includeDefaults = true)
        put("properties", JSONArray().apply { definitions.forEach { put(it.json(reported, actual)) } })
        if (definitions.isEmpty()) put("reason", "当前节点没有可新增属性（虚拟节点或尚无 RenderView）")
    }
    fun supplement(view: DeclarativeBaseView<*, *>, props: MutableMap<String, Any>) {
        val current = entries[view.nativeRef] ?: return
        if (current.view !== view) { entries.remove(view.nativeRef); return }
        val actual = collectViewProps(view, view.getViewAttr(), includeDefaults = true)
        for (key in current.touched) {
            // Keep legacy p/e storage types for old clients; schema reads expose semantic values.
            actual[key]?.let { props[key] = it }
        }
    }
    fun set(view: DeclarativeBaseView<*, *>, token: String, key: String, value: Any?): JSONObject {
        val current = entries[view.nativeRef]
        if (current == null || current.view !== view || current.token != token)
            throw PropEditException("SCHEMA_EXPIRED", "节点或属性能力已变化，请重新查询")
        val definition = supportedProps(view).find { it.key == key }
            ?: throw PropEditException("UNSUPPORTED_PROPERTY", "节点不支持属性：$key")
        try { validateSupportedProp(view, definition, value) }
        catch (t: Throwable) { throw PropEditException("INVALID_VALUE", t.message ?: "属性值不合法") }
        current.touched.add(key)
        try {
            val attr = view.getViewAttr()
            when (key) {
                "backgroundColor" -> attr.backgroundColor(Color((value as Number).toLong()))
                "color" -> (attr as TextAttr).color(Color((value as Number).toLong()))
                "text" -> (attr as TextAttr).text(value as String)
                "fontSize" -> (attr as TextAttr).fontSize((value as Number).toFloat())
                "opacity" -> attr.opacity((value as Number).toFloat())
                "visibility" -> attr.visibility(value as Boolean)
                "touchEnable" -> attr.touchEnable(value as Boolean)
                else -> editProp(view, key, value, supportedLayout = true)
            }
            if (view.flexNode.isDirty) attr.getPager().onLayoutView()
        } catch (t: Throwable) { throw PropEditException("SETTER_FAILED", t.message ?: "属性 setter 执行失败") }
        return JSONObject().apply {
            put("key", key); put("inputType", definition.inputType)
            val actual = if (view.renderView != null) readSupportedProp(view, key) else null
            put("readable", actual != null)
            if (actual != null) put("value", KDevtoolsJson.encode(actual))
            put("reported", actual != null)
        }
    }
}

private fun validateSupportedProp(view: DeclarativeBaseView<*, *>, def: PropDefinition, value: Any?) {
    fun number(v: Any?): Double {
        require(v is Number) { "${def.key} 需要数值" }
        val n = v.toDouble()
        require(n.isFinite() && n.toFloat().isFinite()) { "需要有限 Float 数值" }
        def.min?.let { require(if (def.exclusiveMin) n > it else n >= it) { "数值小于允许范围" } }
        def.max?.let { require(n <= it) { "数值大于允许范围" } }
        return n
    }
    when (def.inputType) {
        "color" -> require(value is Number && value.toDouble().isFinite() && value.toDouble() % 1.0 == 0.0 && value.toDouble() in 0.0..4294967295.0) { "需要 UInt32 ARGB" }
        "boolean" -> require(value is Boolean) { "需要 true 或 false" }
        "string" -> require(value is String && value.length <= 2000) { "文本最多 2000 字符" }
        "enum" -> require(value is String && value in def.enumValues) { "无效枚举值" }
        "number" -> {
            val n = number(value)
            val counterpart = when (def.key) { "minWidth" -> "maxWidth"; "maxWidth" -> "minWidth"; "minHeight" -> "maxHeight"; "maxHeight" -> "minHeight"; else -> null }
            val other = when (counterpart) {
                "minWidth" -> view.flexNode.styleMinWidth
                "maxWidth" -> view.flexNode.styleMaxWidth
                "minHeight" -> view.flexNode.styleMinHeight
                "maxHeight" -> view.flexNode.styleMaxHeight
                else -> null
            }?.takeIf { it.isFinite() }?.toDouble()
            if (other != null) require(if (def.key.startsWith("min")) n <= other else n >= other) { "min 不得大于 max" }
        }
        "space" -> if (value is JSONObject) {
            val keys = value.keys()
            while (keys.hasNext()) require(keys.next() in listOf("top", "left", "bottom", "right")) { "无效间距字段" }
            listOf("top", "left", "bottom", "right").forEach { number(if (value.has(it)) value.opt(it) else 0) }
        } else number(value)
    }
}
