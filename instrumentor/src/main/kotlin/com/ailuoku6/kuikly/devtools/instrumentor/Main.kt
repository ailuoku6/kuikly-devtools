package com.ailuoku6.kuikly.devtools.instrumentor

import java.io.File
import kotlin.system.exitProcess

/**
 * Instruments a directory of Kotlin sources in place.
 *
 * The Gradle init script copies `commonMain` into `build/kuikly-devtools/instrumented` first, so the
 * real project sources are never touched.
 *
 *   java -jar kuikly-devtools-instrumentor.jar <sourceRoot> [--report <file>] [--quiet]
 */
fun main(args: Array<String>) {
    if (args.isEmpty()) {
        System.err.println("usage: kuikly-devtools-instrumentor <sourceRoot> [--report <file>] [--quiet]")
        exitProcess(2)
    }

    val root = File(args[0])
    if (!root.isDirectory) {
        System.err.println("[kuikly-devtools] not a directory: $root")
        exitProcess(2)
    }
    val reportPath = args.indexOf("--report").takeIf { it >= 0 && it + 1 < args.size }?.let { args[it + 1] }
    val quiet = args.contains("--quiet")

    val sources = root.walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()
    if (sources.isEmpty()) {
        println("[kuikly-devtools] no Kotlin sources under $root")
        return
    }

    val started = System.currentTimeMillis()
    val results = ArrayList<FileResult>()

    PsiEnvironment().use { psi ->
        val texts = sources.associateWith { it.readText() }
        val parsed = sources.associateWith { psi.parse(it.name, texts.getValue(it)) }

        // Two passes: the supertype index must be complete before deciding which classes to dump,
        // because a business component often extends another business component.
        val instrumentor = SourceInstrumentor(buildClassIndex(parsed.values.toList()))

        for (file in sources) {
            val relative = file.relativeTo(root).path
            val result = try {
                instrumentor.instrument(relative, texts.getValue(file), parsed.getValue(file))
            } catch (error: Throwable) {
                // A single unparseable or unusual file must not fail the build; it just stays as-is.
                System.err.println("[kuikly-devtools] skipped $relative: ${error.message}")
                continue
            }
            if (result.changed) file.writeText(result.text)
            results += result
        }
    }

    val pages = results.flatMap { it.attachedPages }
    val stateClasses = results.flatMap { it.stateClasses }
    val printlns = results.sumOf { it.rewrittenPrintlns }
    val changedFiles = results.count { it.changed }

    println(
        "[kuikly-devtools] instrumented $changedFiles/${sources.size} files in " +
            "${System.currentTimeMillis() - started}ms: " +
            "${pages.size} pages, ${stateClasses.size} stateful classes, " +
            "$printlns println call sites"
    )
    if (!quiet && pages.isNotEmpty()) {
        println("[kuikly-devtools] pages: ${pages.joinToString(", ")}")
    }
    if (pages.isEmpty()) {
        println("[kuikly-devtools] WARNING no @Page class found - the agent will never attach")
    }

    reportPath?.let { writeReport(File(it), results) }
}

private fun writeReport(target: File, results: List<FileResult>) {
    target.parentFile?.mkdirs()
    target.writeText(
        buildString {
            appendLine("# kuikly-devtools instrumentation report")
            appendLine()
            for (result in results.filter { it.changed }.sortedBy { it.relativePath }) {
                appendLine(result.relativePath)
                if (result.attachedPages.isNotEmpty()) {
                    appendLine("  attachPager: ${result.attachedPages.joinToString(", ")}")
                }
                if (result.stateClasses.isNotEmpty()) {
                    appendLine("  registerState: ${result.stateClasses.joinToString(", ")}")
                }
                if (result.rewrittenPrintlns > 0) {
                    appendLine("  println rewrites: ${result.rewrittenPrintlns}")
                }
            }
        }
    )
}
