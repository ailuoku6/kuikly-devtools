package com.ailuoku6.kuikly.devtools

import com.tencent.kuikly.core.base.ComposeView
import com.tencent.kuikly.core.base.DeclarativeBaseView
import com.tencent.kuikly.core.base.ViewContainer
import com.tencent.kuikly.core.layout.Frame
import com.tencent.kuikly.core.nvi.serialization.json.JSONArray
import com.tencent.kuikly.core.nvi.serialization.json.JSONObject
import com.tencent.kuikly.core.pager.Pager
import com.tencent.kuikly.core.views.ScrollerView

internal class TreeDelta(
    val nodes: JSONArray,
    val removed: JSONArray,
    val total: Int,
    val changed: Int
)

/**
 * Walks the Kuikly declarative view tree and produces either a full snapshot or a per-node delta.
 *
 * The walk uses [ViewContainer.templateChildren] rather than the native render tree, so virtual
 * (flattened) containers and `ComposeView` boundaries stay visible — that is what makes the panel's
 * component hierarchy match the DSL the developer actually wrote.
 */
internal class KDevtoolsTree(private val pager: Pager, private val propSchema: KDevtoolsPropSchema? = null) {

    private val lastSerialized = HashMap<Int, String>()
    private var aliveIds = HashSet<Int>()

    /**
     * @param full ignore the diff cache and emit every node
     * @param stateNodeIds nodes the panel currently has open; only those pay the state-dump cost
     * @param includeAll emit every node without clearing the actual-change cache
     */
    fun collect(full: Boolean, stateNodeIds: Set<Int>, includeAll: Boolean = false): TreeDelta {
        val nodes = JSONArray()
        val removed = JSONArray()
        val alive = HashSet<Int>()
        var total = 0
        var changed = 0

        if (full) {
            lastSerialized.clear()
        }

        val stack = ArrayList<Frame>()
        stack.add(Frame(pager, -1, 0))
        // Explicit stack: business pages nest deeply and recursion depth is not worth the risk.
        while (stack.isNotEmpty()) {
            val current = stack.removeAt(stack.size - 1)
            val view = current.view
            total++
            alive.add(view.nativeRef)

            val json = describe(view, current.parentId, current.childIndex, stateNodeIds)
            val serialized = json.toString()
            // Requested state and screenshot trees may be resent unchanged. Count only actual
            // serialized changes so resending cannot continuously trigger live screenshots.
            val differs = lastSerialized[view.nativeRef] != serialized
            if (includeAll || stateNodeIds.contains(view.nativeRef) || differs) nodes.put(json)
            if (differs) changed++
            lastSerialized[view.nativeRef] = serialized

            if (view is ViewContainer<*, *>) {
                val children = try {
                    view.templateChildren()
                } catch (t: Throwable) {
                    emptyList()
                }
                for (index in children.indices.reversed()) {
                    stack.add(Frame(children[index], view.nativeRef, index))
                }
            }
        }

        for (id in aliveIds) {
            if (!alive.contains(id)) {
                removed.put(id)
                lastSerialized.remove(id)
            }
        }
        propSchema?.prune(alive)
        aliveIds = alive

        return TreeDelta(nodes, removed, total, changed)
    }

    private class Frame(
        val view: DeclarativeBaseView<*, *>,
        val parentId: Int,
        val childIndex: Int
    )

    private fun describe(
        view: DeclarativeBaseView<*, *>,
        parentId: Int,
        childIndex: Int,
        stateNodeIds: Set<Int>
    ): JSONObject {
        val json = JSONObject()
        json.put("id", view.nativeRef)
        json.put("pid", parentId)
        // Template index, so the panel can render siblings in DSL order even though deltas arrive
        // out of order.
        json.put("ci", childIndex)
        json.put("n", safeViewName(view))
        json.put("c", view::class.simpleName ?: "?")
        json.put("r", view.renderView != null)
        json.put("cv", view is ComposeView<*, *>)

        val local = try {
            view.frame
        } catch (t: Throwable) {
            null
        }
        val absolute = try {
            local?.let { view.convertFrame(it, null) }
        } catch (t: Throwable) {
            null
        }
        if (local != null) {
            json.put("f", JSONArray().apply {
                put(round(absolute?.x ?: local.x))
                put(round(absolute?.y ?: local.y))
                put(round(local.width))
                put(round(local.height))
            })
            json.put("lf", JSONArray().apply {
                put(round(local.x))
                put(round(local.y))
            })
        }

        // Kuikly convertFrame ignores scroller contentOffset. The panel maps `f` through ancestor
        // `so` so screenshot pick matches what Pager.toImage actually drew.
        val scroller = view as? ScrollerView<*, *>
        if (scroller != null) {
            json.put("so", JSONArray().apply {
                put(round(scroller.curOffsetX))
                put(round(scroller.curOffsetY))
            })
        }

        val attr = try {
            view.getViewAttr()
        } catch (t: Throwable) {
            null
        }
        val props = collectViewProps(view, attr).toMutableMap()
        propSchema?.supplement(view, props)
        json.put("p", KDevtoolsJson.objectOf(props))
        val editable = JSONObject()
        editable.put("p", KDevtoolsJson.objectOf(editableProps(props)))
        json.put("e", editable)

        val hasOwnState = KDevtools.hasState(view)
        val hasAttrState = attr != null && KDevtools.hasState(attr)
        json.put("hs", hasOwnState || hasAttrState)

        if (stateNodeIds.contains(view.nativeRef)) {
            if (hasOwnState) {
                KDevtools.dumpState(view)?.let {
                    json.put("s", KDevtoolsJson.objectOf(it))
                    editable.put("s", KDevtoolsJson.objectOf(KDevtools.editableState(view, it)))
                }
            }
            if (hasAttrState && attr != null) {
                KDevtools.dumpState(attr)?.let {
                    json.put("as", KDevtoolsJson.objectOf(it))
                    editable.put("as", KDevtoolsJson.objectOf(KDevtools.editableState(attr, it)))
                }
            }
        }
        return json
    }

    private fun safeViewName(view: DeclarativeBaseView<*, *>): String = try {
        view.viewName()
    } catch (t: Throwable) {
        "?"
    }

    private fun round(value: Float): Double = roundFrame(value)
}

/**
 * Page-root rect of [view] as it appears on screen: layout [convertFrame] minus ancestor
 * [ScrollerView] content offsets. Transform is still ignored here (the panel applies `p.transform`).
 *
 * Used for screenshot `ox/oy/ow/oh` so a captured node lines up with the pick overlay.
 */
internal fun pageVisualFrame(view: DeclarativeBaseView<*, *>): Frame? {
    val local = try {
        view.frame
    } catch (t: Throwable) {
        return null
    }
    val absolute = try {
        view.convertFrame(local, null)
    } catch (t: Throwable) {
        local
    }
    var x = absolute.x
    var y = absolute.y
    var parent = try {
        view.domParent
    } catch (t: Throwable) {
        null
    }
    while (parent != null) {
        val scroller = parent as? ScrollerView<*, *>
        if (scroller != null) {
            x -= scroller.curOffsetX
            y -= scroller.curOffsetY
        }
        parent = try {
            parent.domParent
        } catch (t: Throwable) {
            null
        }
    }
    return Frame(x, y, local.width, local.height)
}

internal fun roundFrame(value: Float): Double {
    val scaled = (value * 100f).toInt()
    return scaled / 100.0
}
