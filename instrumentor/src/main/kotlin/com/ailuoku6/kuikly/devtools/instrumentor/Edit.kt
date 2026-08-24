package com.ailuoku6.kuikly.devtools.instrumentor

/**
 * A single text replacement expressed in source offsets.
 *
 * Replacements must never contain a newline: keeping the line count identical to the original file is
 * what lets stack traces from the instrumented build still point at the right line of the real source.
 */
class Edit(val start: Int, val end: Int, val replacement: String, val reason: String) {
    init {
        require(!replacement.contains('\n')) { "instrumentation must not add lines: $replacement" }
        require(start <= end) { "invalid edit range $start..$end" }
    }
}

/** Applies edits back to front so earlier offsets stay valid. */
fun applyEdits(source: String, edits: List<Edit>): String {
    if (edits.isEmpty()) return source
    val ordered = edits.sortedWith(compareByDescending<Edit> { it.start }.thenByDescending { it.end })
    val builder = StringBuilder(source)
    var previousStart = Int.MAX_VALUE
    for (edit in ordered) {
        check(edit.end <= previousStart) {
            "overlapping edits: ${edit.reason} at ${edit.start}..${edit.end}"
        }
        builder.replace(edit.start, edit.end, edit.replacement)
        previousStart = edit.start
    }
    return builder.toString()
}
