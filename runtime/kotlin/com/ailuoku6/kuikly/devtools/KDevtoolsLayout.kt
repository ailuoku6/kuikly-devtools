package com.ailuoku6.kuikly.devtools

import com.tencent.kuikly.core.base.Attr
import com.tencent.kuikly.core.base.DeclarativeBaseView
import com.tencent.kuikly.core.layout.FlexAlign
import com.tencent.kuikly.core.layout.FlexDirection
import com.tencent.kuikly.core.layout.FlexJustifyContent
import com.tencent.kuikly.core.layout.FlexLayout
import com.tencent.kuikly.core.layout.FlexNode
import com.tencent.kuikly.core.layout.FlexPositionType
import com.tencent.kuikly.core.layout.FlexWrap
import com.tencent.kuikly.core.layout.StyleSpace
import com.tencent.kuikly.core.layout.isUndefined
import com.tencent.kuikly.core.layout.valueEquals

/**
 * Inspector props for one node.
 *
 * Render/style keys (`backgroundColor`, `text`, `opacity`, …) live in [Attr]'s `propsMap` and come
 * from [Attr.copyPropsMap]. Layout keys (`margin`, `padding`, `width`, `flex`, …) are written only
 * to [FlexNode] and never enter `propsMap`, so they have to be copied from the public FlexNode
 * getters. Default Yoga values are omitted so every Div does not look as if it set `flex: 0`.
 *
 * `top` / `left` / `bottom` / `right` live on [FlexNode.stylePosition]. Kuikly never published a
 * getter (only [FlexNode.setStylePosition]), so we read the `internal` property under a visibility
 * suppress — the getter is in the klib on JVM, JS and Native; Native links it because the app and
 * kuikly-core are one binary. Undefined sides are `NaN` and are skipped.
 */
internal fun collectViewProps(view: DeclarativeBaseView<*, *>, attr: Attr?, includeDefaults: Boolean = false): Map<String, Any> {
    val props = LinkedHashMap<String, Any>()
    if (attr != null) {
        if (attr.keepAlive) {
            props["keepAlive"] = true
        }
        try {
            props.putAll(attr.copyPropsMap())
        } catch (t: Throwable) {
            // A throwing getter on a custom Attr must not drop FlexNode layout either.
        }
    }
    try {
        collectFlexStyle(view.flexNode, props, includeDefaults)
    } catch (t: Throwable) {
        // FlexNode getters are public and stable; still isolate so one bad node does not kill the tick.
    }
    return props
}

private fun collectFlexStyle(node: FlexNode, props: MutableMap<String, Any>, defaults: Boolean) {
    putDefined(props, "width", node.styleWidth, defaults)
    putDefined(props, "height", node.styleHeight, defaults)
    putDefined(props, "minWidth", node.styleMinWidth, defaults)
    putDefined(props, "minHeight", node.styleMinHeight, defaults)
    putDefined(props, "maxWidth", node.styleMaxWidth, defaults)
    putDefined(props, "maxHeight", node.styleMaxHeight, defaults)
    if (defaults || !node.flex.valueEquals(0f)) {
        props["flex"] = if (defaults) node.flex.toDouble() else roundFrame(node.flex)
    }
    spaceSides(defaults) { node.getMargin(it) }?.let { props["margin"] = it }
    spaceSides(defaults) { node.getPadding(it) }?.let { props["padding"] = it }
    if (defaults || node.flexDirection != FlexDirection.COLUMN) {
        props["flexDirection"] = node.flexDirection.name
    }
    if (defaults || node.flexWrap != FlexWrap.NOWRAP) {
        props["flexWrap"] = node.flexWrap.name
    }
    if (defaults || node.justifyContent != FlexJustifyContent.FLEX_START) {
        props["justifyContent"] = node.justifyContent.name
    }
    if (defaults || node.alignItems != FlexAlign.STRETCH) {
        props["alignItems"] = node.alignItems.name
    }
    if (defaults || node.alignSelf != FlexAlign.AUTO) {
        props["alignSelf"] = node.alignSelf.name
    }
    if (defaults || node.alignContent != FlexAlign.FLEX_START) {
        props["alignContent"] = node.alignContent.name
    }
    if (defaults || node.positionType != FlexPositionType.RELATIVE) {
        props["positionType"] = node.positionType.name
    }
    try {
        collectStylePosition(node, props, defaults)
    } catch (t: Throwable) {
        // Visibility suppress is compile-time; isolate anyway so one Kuikly version cannot drop the rest.
    }
}

/**
 * Kuikly's public API is write-only: [FlexNode.setStylePosition]. The matching getter is
 * `internal val stylePosition` (used by LayoutImpl in the same module). Suppressing the
 * cross-module visibility check is how we read what `attr { top(); left(); … }` stored.
 */
@Suppress("INVISIBLE_REFERENCE", "INVISIBLE_MEMBER")
private fun collectStylePosition(node: FlexNode, props: MutableMap<String, Any>, precise: Boolean) {
    val position = node.stylePosition
    putDefined(props, "left", position[FlexLayout.PositionType.POSITION_LEFT.ordinal], precise)
    putDefined(props, "top", position[FlexLayout.PositionType.POSITION_TOP.ordinal], precise)
    putDefined(props, "right", position[FlexLayout.PositionType.POSITION_RIGHT.ordinal], precise)
    putDefined(props, "bottom", position[FlexLayout.PositionType.POSITION_BOTTOM.ordinal], precise)
}

private fun putDefined(props: MutableMap<String, Any>, key: String, value: Float, precise: Boolean) {
    if (!value.isUndefined()) {
        props[key] = if (precise) value.toDouble() else roundFrame(value)
    }
}

/**
 * Uniform `margin(10f)` becomes the number `10`. Mixed sides become `{top, left, bottom, right}`
 * with zero sides omitted. All-zero (Yoga default) is dropped.
 */
private fun spaceSides(defaults: Boolean, get: (StyleSpace.Type) -> Float): Any? {
    val top = get(StyleSpace.Type.TOP)
    val left = get(StyleSpace.Type.LEFT)
    val bottom = get(StyleSpace.Type.BOTTOM)
    val right = get(StyleSpace.Type.RIGHT)
    if (!defaults && top.valueEquals(0f) && left.valueEquals(0f) && bottom.valueEquals(0f) && right.valueEquals(0f)) {
        return null
    }
    if (top.valueEquals(left) && left.valueEquals(bottom) && bottom.valueEquals(right)) {
        return if (defaults) top.toDouble() else roundFrame(top)
    }
    val sides = LinkedHashMap<String, Double>()
    if (!top.valueEquals(0f)) sides["top"] = if (defaults) top.toDouble() else roundFrame(top)
    if (!left.valueEquals(0f)) sides["left"] = if (defaults) left.toDouble() else roundFrame(left)
    if (!bottom.valueEquals(0f)) sides["bottom"] = if (defaults) bottom.toDouble() else roundFrame(bottom)
    if (!right.valueEquals(0f)) sides["right"] = if (defaults) right.toDouble() else roundFrame(right)
    return sides
}
