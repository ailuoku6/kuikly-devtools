package com.ailuoku6.kuikly.devtools

import com.tencent.kuikly.core.base.Color
import com.tencent.kuikly.core.base.DeclarativeBaseView
import com.tencent.kuikly.core.layout.FlexAlign
import com.tencent.kuikly.core.layout.FlexDirection
import com.tencent.kuikly.core.layout.FlexJustifyContent
import com.tencent.kuikly.core.layout.FlexPositionType
import com.tencent.kuikly.core.layout.FlexWrap
import com.tencent.kuikly.core.layout.FlexLayout
import com.tencent.kuikly.core.layout.StyleSpace
import com.tencent.kuikly.core.nvi.serialization.json.JSONObject

/** Types, not display formatting. All ARGB parsing/formatting lives in the server. */
internal fun editType(value: Any?, hint: String = ""): String? {
    val type = when (value) {
        is Color -> "Color"
        is String -> if (value.length <= 2000) "String" else return null
        is Boolean -> "Boolean"
        is Byte -> "Byte"
        is Short -> "Short"
        is Int -> "Int"
        is Long -> if (value in -9007199254740991L..9007199254740991L) "Long" else return null
        is Float -> if (value.isFinite()) "Float" else return null
        is Double -> if (value.isFinite()) "Double" else return null
        is Char -> "Char"
        null -> hint.removeSuffix("?").substringAfterLast('.').takeIf {
            hint.endsWith("?") && it in setOf("Color", "String", "Boolean", "Byte", "Short", "Int", "Long", "Float", "Double", "Char")
        } ?: return null
        else -> return null
    }
    return type + if (hint.endsWith("?")) "?" else ""
}

internal fun coerceEdit(current: Any?, value: Any?, hint: String = ""): Any? {
    val declared = editType(current, hint) ?: error("Unsupported or unreadable field type")
    if (value == null) {
        require(declared.endsWith("?")) { "Field is not nullable" }
        return null
    }
    val type = declared.removeSuffix("?")
    fun number(): Double {
        require(value is Number) { "Expected a number" }
        return value.toDouble().also { require(it.isFinite()) { "Expected a finite number" } }
    }
    fun integer(min: Double, max: Double): Long {
        val n = number()
        require(n % 1.0 == 0.0 && n >= min && n <= max) { "Out of range for $type" }
        return n.toLong()
    }
    return when (type) {
        "Color" -> if (value is String) Color(value) else Color(integer(0.0, 4294967295.0))
        "String" -> { require(value is String); value }
        "Boolean" -> { require(value is Boolean); value }
        "Char" -> { require(value is String && value.length == 1); value[0] }
        "Byte" -> integer(-128.0, 127.0).toByte()
        "Short" -> integer(-32768.0, 32767.0).toShort()
        "Int" -> integer(-2147483648.0, 2147483647.0).toInt()
        "Long" -> integer(-9007199254740991.0, 9007199254740991.0)
        "Float" -> number().toFloat().also { require(it.isFinite()) }
        "Double" -> number()
        else -> error("Unsupported field type")
    }
}

internal val layoutNumbers = setOf("width", "height", "minWidth", "minHeight", "maxWidth", "maxHeight", "flex", "top", "left", "bottom", "right")
internal val layoutEnums = mapOf(
    "flexDirection" to FlexDirection.values().map { it.name },
    "flexWrap" to FlexWrap.values().map { it.name },
    "justifyContent" to FlexJustifyContent.values().map { it.name },
    "alignItems" to FlexAlign.values().map { it.name },
    "alignSelf" to FlexAlign.values().map { it.name },
    "alignContent" to FlexAlign.values().map { it.name },
    "positionType" to FlexPositionType.values().map { it.name }
)

internal fun editableProps(props: Map<String, Any>): Map<String, String> {
    val result = LinkedHashMap<String, String>()
    for ((key, value) in props) {
        val type = when {
            key in layoutNumbers -> "Float"
            key == "margin" || key == "padding" -> "space"
            key in layoutEnums -> "enum:" + layoutEnums.getValue(key).joinToString(",")
            else -> editType(value)
        }
        if (type != null) result[key] = type
    }
    return result
}

internal fun editProp(view: DeclarativeBaseView<*, *>, key: String, value: Any?, supportedLayout: Boolean = false) {
    val attr = view.getViewAttr()
    val props = collectViewProps(view, attr)
    require(editableProps(props).containsKey(key) || (supportedLayout && (key in layoutNumbers || key in layoutEnums || key == "margin" || key == "padding"))) { "Unknown or read-only property: $key" }
    val node = view.flexNode
    if (key in layoutNumbers) {
        val n = coerceEdit(0f, value) as Float
        when (key) {
            "width" -> node.styleWidth = n
            "height" -> node.styleHeight = n
            "minWidth" -> node.styleMinWidth = n
            "minHeight" -> node.styleMinHeight = n
            "maxWidth" -> node.styleMaxWidth = n
            "maxHeight" -> node.styleMaxHeight = n
            "flex" -> node.flex = n
            "top" -> node.setStylePosition(FlexLayout.PositionType.POSITION_TOP, n)
            "left" -> node.setStylePosition(FlexLayout.PositionType.POSITION_LEFT, n)
            "bottom" -> node.setStylePosition(FlexLayout.PositionType.POSITION_BOTTOM, n)
            "right" -> node.setStylePosition(FlexLayout.PositionType.POSITION_RIGHT, n)
        }
    } else if (key == "margin" || key == "padding") {
        // Validate all four sides before making any change.
        val sides = listOf("top", "left", "bottom", "right").map { side ->
            coerceEdit(0f, if (value is JSONObject) value.opt(side) ?: 0 else value) as Float
        }
        val types = listOf(StyleSpace.Type.TOP, StyleSpace.Type.LEFT, StyleSpace.Type.BOTTOM, StyleSpace.Type.RIGHT)
        types.forEachIndexed { index, side ->
            if (key == "margin") node.setMargin(side, sides[index]) else node.setPadding(side, sides[index])
        }
    } else if (key in layoutEnums) {
        require(value is String && layoutEnums.getValue(key).contains(value)) { "Invalid enum value" }
        when (key) {
            "flexDirection" -> node.flexDirection = FlexDirection.valueOf(value)
            "flexWrap" -> node.flexWrap = FlexWrap.valueOf(value)
            "justifyContent" -> node.justifyContent = FlexJustifyContent.valueOf(value)
            "alignItems" -> node.alignItems = FlexAlign.valueOf(value)
            "alignSelf" -> node.alignSelf = FlexAlign.valueOf(value)
            "alignContent" -> node.alignContent = FlexAlign.valueOf(value)
            "positionType" -> node.positionType = FlexPositionType.valueOf(value)
        }
    } else if (key == "keepAlive") {
        attr.keepAlive = coerceEdit(attr.keepAlive, value) as Boolean
    } else {
        attr.setProp(key, coerceEdit(attr.getProp(key), value) ?: error("Null prop is unsupported"))
    }
    if (node.isDirty) attr.getPager().onLayoutView()
}
