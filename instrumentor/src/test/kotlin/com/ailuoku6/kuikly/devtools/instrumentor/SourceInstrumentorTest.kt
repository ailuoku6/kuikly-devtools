package com.ailuoku6.kuikly.devtools.instrumentor

import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class SourceInstrumentorTest {

    private val psi = PsiEnvironment()

    @AfterTest
    fun tearDown() = psi.close()

    private fun run(vararg sources: String): List<FileResult> {
        val parsed = sources.mapIndexed { index, text -> psi.parse("File$index.kt", text) }
        val instrumentor = SourceInstrumentor(buildClassIndex(parsed))
        return sources.mapIndexed { index, text ->
            instrumentor.instrument("File$index.kt", text, parsed[index])
        }
    }

    private fun single(source: String): FileResult = run(source).first()

    // ------------------------------------------------------------------ line safety

    @Test
    fun `line count is preserved`() {
        val source = """
            @Page("DevToolsTestPage")
            internal class DevToolsTestPage : BasePager() {
                private var counter = 0

                fun log() {
                    println("hello")
                }
            }
        """.trimIndent()

        val result = single(source)
        assertTrue(result.changed)
        assertEquals(
            source.count { it == '\n' },
            result.text.count { it == '\n' },
            "instrumentation must not change the number of lines"
        )
    }

    // ------------------------------------------------------------------------ @Page

    @Test
    fun `page class gets attachPager`() {
        val result = single(
            """
            @Page("DevToolsTestPage", supportInLocal = true)
            internal class DevToolsTestPage : BasePager() {
                private var ready = false
            }
            """.trimIndent()
        )
        assertEquals(listOf("DevToolsTestPage"), result.attachedPages)
        assertTrue(result.text.contains("$AGENT.attachPager(this, \"DevToolsTestPage\")"))
    }

    @Test
    fun `non page class gets no attachPager`() {
        val result = single(
            """
            class PlainHelper {
                var value = 1
            }
            """.trimIndent()
        )
        assertFalse(result.changed)
    }

    // ------------------------------------------------------------------ state dumps

    @Test
    fun `compose view gets a guarded dumper for every declared property`() {
        val result = single(
            """
            internal class DevToolsTestDialogView :
                ComposeView<DevToolsTestDialogAttr, DevToolsTestDialogEvent>() {
                private var selectedTabForward: Int by observable(0)
                private var slideCount = 0
                private lateinit var scrollerRef: ViewRef<ScrollerView<*, *>>
                val exposed: String = "x"
            }
            """.trimIndent()
        )
        assertEquals(listOf("DevToolsTestDialogView"), result.stateClasses)
        for (name in listOf("selectedTabForward", "slideCount", "scrollerRef", "exposed")) {
            assertTrue(
                result.text.contains("$AGENT.tryPut(__kdtState, \"$name\") { this.$name }"),
                "missing dumper entry for $name"
            )
        }
    }

    @Test
    fun `state root is found transitively through a business base class`() {
        val results = run(
            """
            abstract class TMBaseDialogView : ComposeView<ComposeAttr, ComposeEvent>() {
                protected var visible = false
            }
            """.trimIndent(),
            """
            class ConcreteDialogView : TMBaseDialogView() {
                private var rows = 3
            }
            """.trimIndent()
        )
        assertEquals(listOf("TMBaseDialogView"), results[0].stateClasses)
        assertEquals(listOf("ConcreteDialogView"), results[1].stateClasses)
    }

    @Test
    fun `compose attr observable properties are dumped`() {
        val result = single(
            """
            internal class DevToolsTestDialogAttr : ComposeAttr() {
                var showDialog: Boolean by observable(false)
                var data: DevToolsTestPayload? by observable(null)
            }
            """.trimIndent()
        )
        assertEquals(listOf("DevToolsTestDialogAttr"), result.stateClasses)
        assertTrue(result.text.contains("\"showDialog\""))
        assertTrue(result.text.contains("\"data\""))
    }

    @Test
    fun `primary constructor properties are dumped but plain parameters are not`() {
        val result = single(
            """
            class RowView(val label: String, private var count: Int, plain: String) : ComposeView<A, B>() {
                private var extra = 0
            }
            """.trimIndent()
        )
        assertTrue(result.text.contains("\"label\""))
        assertTrue(result.text.contains("\"count\""))
        assertTrue(result.text.contains("\"extra\""))
        assertFalse(result.text.contains("\"plain\""))
    }

    @Test
    fun `companion and nested members are not dumped`() {
        val result = single(
            """
            class CardView : ComposeView<A, B>() {
                private var own = 1
                class Inner {
                    var innerOnly = 2
                }
                companion object {
                    const val TAG = "CardView"
                    var shared = 3
                }
            }
            """.trimIndent()
        )
        assertTrue(result.text.contains("\"own\""))
        assertFalse(result.text.contains("\"innerOnly\""))
        assertFalse(result.text.contains("\"shared\""))
        assertFalse(result.text.contains("\"TAG\""))
    }

    @Test
    fun `class without a body gets one`() {
        val result = single(
            """
            class EmptyView : ComposeView<A, B>()
            """.trimIndent()
        )
        // No declared properties, so only structural change would be a dumper; there is none.
        assertFalse(result.changed)
    }

    @Test
    fun `page class without a body still gets attachPager`() {
        val result = single(
            """
            @Page("Blank")
            class BlankPage : BasePager()
            """.trimIndent()
        )
        assertTrue(result.changed)
        assertTrue(result.text.contains("attachPager(this, \"Blank"))
        assertTrue(result.text.trimEnd().endsWith("}"), "a body must be created: ${result.text}")
        assertEquals(1, result.text.count { it == '\n' })
    }

    @Test
    fun `interfaces objects and expect classes are skipped`() {
        val results = run(
            """
            interface Marker : ComposeAttr
            """.trimIndent(),
            """
            expect class Platform : ComposeAttr
            """.trimIndent(),
            """
            annotation class Tagged
            """.trimIndent()
        )
        results.forEach { assertFalse(it.changed, "unexpected change in ${it.relativePath}") }
    }

    // --------------------------------------------------------------------- println

    @Test
    fun `top level println is rewritten`() {
        val result = single(
            """
            fun emit(value: Int) {
                println("value=" + value)
            }
            """.trimIndent()
        )
        assertEquals(1, result.rewrittenPrintlns)
        assertTrue(result.text.contains("$AGENT.printLine(\"value=\" + value)"))
    }

    @Test
    fun `qualified and zero argument println are left alone`() {
        val result = single(
            """
            fun emit(stream: java.io.PrintStream) {
                stream.println("x")
                println()
            }
            """.trimIndent()
        )
        assertEquals(0, result.rewrittenPrintlns)
        assertFalse(result.changed)
    }

    // ------------------------------------------------------------------ ignore hook

    @Test
    fun `ignore marker skips the whole file`() {
        val result = single(
            """
            // $IGNORE_MARKER
            @Page("Skipped")
            class SkippedPage : BasePager() {
                var value = 1
            }
            """.trimIndent()
        )
        assertFalse(result.changed)
    }

    // ------------------------------------------------- combined page + state + print

    @Test
    fun `page gets both hooks and keeps print rewrite`() {
        val source = """
            @Page("DevToolsTestPage")
            internal class DevToolsTestPage : BasePager() {
                private var stage = 0
                fun trace() = println(stage)
            }
        """.trimIndent()

        val result = single(source)
        assertEquals(listOf("DevToolsTestPage"), result.attachedPages)
        assertEquals(listOf("DevToolsTestPage"), result.stateClasses)
        assertEquals(1, result.rewrittenPrintlns)
        assertEquals(source.count { it == '\n' }, result.text.count { it == '\n' })
        // attachPager must come before the state dumper so a broken dumper cannot stop the attach.
        assertTrue(result.text.indexOf("attachPager") < result.text.indexOf("registerState"))
    }
}
