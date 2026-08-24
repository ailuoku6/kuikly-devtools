package com.ailuoku6.kuikly.devtools.instrumentor

import org.jetbrains.kotlin.psi.KtCallExpression
import org.jetbrains.kotlin.psi.KtClass
import org.jetbrains.kotlin.psi.KtClassBody
import org.jetbrains.kotlin.psi.KtDotQualifiedExpression
import org.jetbrains.kotlin.psi.KtFile
import org.jetbrains.kotlin.psi.KtNameReferenceExpression
import org.jetbrains.kotlin.psi.KtParameter
import org.jetbrains.kotlin.psi.KtProperty
import org.jetbrains.kotlin.psi.psiUtil.collectDescendantsOfType

const val AGENT = "com.ailuoku6.kuikly.devtools.KDevtools"
const val IGNORE_MARKER = "kuikly-devtools:ignore"

/** Direct or transitive supertypes that make a class worth dumping member variables for. */
val STATE_ROOTS = setOf("ComposeView", "ComposeAttr", "Pager", "BasePager")

class FileResult(
    val relativePath: String,
    val text: String,
    val changed: Boolean,
    val attachedPages: List<String>,
    val stateClasses: List<String>,
    val rewrittenPrintlns: Int
)

class ClassShape(val simpleName: String, val superTypeNames: List<String>)

/**
 * Rewrites Kotlin sources so the DevTools agent can attach itself and read member variables.
 *
 * Three rules, all implemented as pure offset inserts:
 *  1. `@Page` classes get `KDevtools.attachPager(this, "Name")`
 *  2. classes rooted at `ComposeView` / `ComposeAttr` / `Pager` get a state dumper
 *  3. `println(x)` becomes `KDevtools.printLine(x)`
 *
 * Nothing is deleted and no newline is ever introduced, so the instrumented copy stays diffable
 * against the original and line numbers keep matching.
 */
class SourceInstrumentor(private val classIndex: Map<String, ClassShape>) {

    fun instrument(relativePath: String, source: String, file: KtFile): FileResult {
        if (source.contains(IGNORE_MARKER)) {
            return FileResult(relativePath, source, false, emptyList(), emptyList(), 0)
        }

        val edits = ArrayList<Edit>()
        val attachedPages = ArrayList<String>()
        val stateClasses = ArrayList<String>()

        for (klass in file.collectDescendantsOfType<KtClass>()) {
            if (!isInstrumentable(klass)) continue
            val name = klass.name ?: continue

            val isPage = klass.annotationEntries.any { it.shortName?.asString() == "Page" }
            val wantsState = rootsAt(name)
            if (!isPage && !wantsState) continue

            val statements = ArrayList<String>()
            if (isPage) {
                statements += "init { $AGENT.attachPager(this, ${name.quoted()}) }"
                attachedPages += name
            }
            if (wantsState) {
                val properties = dumpableProperties(klass)
                if (properties.isNotEmpty()) {
                    statements += stateRegistration(properties)
                    stateClasses += name
                }
            }
            if (statements.isEmpty()) continue

            edits += classBodyInsert(klass, " " + statements.joinToString(" "), name)
        }

        var printlnCount = 0
        for (call in file.collectDescendantsOfType<KtCallExpression>()) {
            val callee = call.calleeExpression as? KtNameReferenceExpression ?: continue
            if (callee.getReferencedName() != "println") continue
            // `System.out.println(...)` and `foo.println(...)` are not the stdlib top-level function.
            if (call.parent is KtDotQualifiedExpression &&
                (call.parent as KtDotQualifiedExpression).selectorExpression === call
            ) {
                continue
            }
            // A trailing lambda or a zero-argument call is not the single-value overload we replace.
            if (call.lambdaArguments.isNotEmpty()) continue
            if (call.valueArguments.size != 1) continue
            if (call.valueArguments.any { it.getArgumentName() != null }) continue

            edits += Edit(
                callee.textRange.startOffset,
                callee.textRange.endOffset,
                "$AGENT.printLine",
                "println at ${callee.textRange.startOffset}"
            )
            printlnCount++
        }

        if (edits.isEmpty()) {
            return FileResult(relativePath, source, false, emptyList(), emptyList(), 0)
        }
        return FileResult(
            relativePath,
            applyEdits(source, edits),
            true,
            attachedPages,
            stateClasses,
            printlnCount
        )
    }

    // ------------------------------------------------------------------ class rules

    private fun isInstrumentable(klass: KtClass): Boolean {
        if (klass.isInterface() || klass.isAnnotation() || klass.isEnum()) return false
        val modifiers = klass.modifierList?.text ?: ""
        // `expect` has no body to run and `external`/`value` classes cannot carry an init block.
        if (modifiers.contains("expect") || modifiers.contains("external")) return false
        if (modifiers.contains("value") || modifiers.contains("inline")) return false
        return klass.name != null
    }

    /** Walks the syntactic supertype chain looking for a state root. */
    private fun rootsAt(simpleName: String): Boolean {
        val seen = HashSet<String>()
        val queue = ArrayDeque<String>()
        queue += simpleName
        while (queue.isNotEmpty()) {
            val current = queue.removeFirst()
            if (!seen.add(current)) continue
            if (current != simpleName && current in STATE_ROOTS) return true
            val shape = classIndex[current] ?: continue
            for (superName in shape.superTypeNames) {
                if (superName in STATE_ROOTS) return true
                queue += superName
            }
        }
        return false
    }

    /**
     * Properties declared directly in the class body plus `val`/`var` primary constructor parameters.
     *
     * Nested classes and companions are skipped: their members belong to a different instance.
     */
    private fun dumpableProperties(klass: KtClass): List<String> {
        val names = LinkedHashSet<String>()

        klass.primaryConstructor?.valueParameters?.forEach { parameter ->
            if (parameter.hasValOrVar()) parameter.name?.let(names::add)
        }

        klass.body?.properties?.forEach { property ->
            if (isDumpable(property)) property.name?.let(names::add)
        }

        return names.filter { it != STATE_LOCAL }.toList()
    }

    private fun isDumpable(property: KtProperty): Boolean {
        if (property.receiverTypeReference != null) return false // extension property
        val modifiers = property.modifierList?.text ?: ""
        if (modifiers.contains("const")) return false
        if (modifiers.contains("expect") || modifiers.contains("external")) return false
        return property.name != null
    }

    private fun stateRegistration(properties: List<String>): String = buildString {
        append("init { $AGENT.registerState(this) { ")
        append("val $STATE_LOCAL = LinkedHashMap<String, Any?>(); ")
        for (name in properties) {
            // One guarded lambda per field so an uninitialised `lateinit` or a throwing getter only
            // blanks out that entry instead of the whole dump.
            append("$AGENT.tryPut($STATE_LOCAL, ${name.quoted()}) { this.$name }; ")
        }
        append("$STATE_LOCAL } }")
    }

    /** Appends to the very end of the class body, after all property initialisers have run. */
    private fun classBodyInsert(klass: KtClass, text: String, name: String): Edit {
        val body: KtClassBody? = klass.body
        if (body != null) {
            val closing = body.rBrace
            if (closing != null) {
                return Edit(
                    closing.textRange.startOffset,
                    closing.textRange.startOffset,
                    text + " ",
                    "class body of $name"
                )
            }
        }
        // No body at all (`class Foo : Bar()`): create one right after the header.
        val end = klass.textRange.endOffset
        return Edit(end, end, " {$text }", "new class body for $name")
    }

    private fun String.quoted(): String = "\"" + replace("\\", "\\\\").replace("\"", "\\\"") + "\""

    private companion object {
        /** Unlikely to collide with a business property name. */
        const val STATE_LOCAL = "__kdtState"
    }
}

/** Builds the simple-name -> direct supertypes index used for the transitive root check. */
fun buildClassIndex(files: List<KtFile>): Map<String, ClassShape> {
    val index = HashMap<String, ClassShape>()
    for (file in files) {
        for (klass in file.collectDescendantsOfType<KtClass>()) {
            val name = klass.name ?: continue
            val supers = klass.superTypeListEntries.mapNotNull { entry ->
                entry.typeReference?.text?.let(::simpleTypeName)
            }
            index[name] = ClassShape(name, supers)
        }
    }
    return index
}

/** `com.foo.ComposeView<A, B>` -> `ComposeView` */
fun simpleTypeName(reference: String): String =
    reference.substringBefore('<').trim().substringAfterLast('.').trim()

fun KtParameter.hasValOrVar(): Boolean = valOrVarKeyword != null
