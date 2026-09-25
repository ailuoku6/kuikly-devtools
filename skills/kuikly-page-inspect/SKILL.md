---
name: kuikly-page-inspect
description: Inspect and edit a live Kuikly page through kuikly-devtools. Use when debugging UI structure, component state, logs, network or native calls, or when asked to change live node properties or component state. Search relevant nodes and inspect their writable types or supported-property schema before editing, including properties absent from attr.
---

# Kuikly Page Inspect

Use this skill whenever the task depends on what a running Kuikly page currently displays, logs, or requests. The DevTools server must be running and the page must have attached through an instrumented build.

Run commands from the Kuikly project root. Successful output is JSON; command failures exit nonzero. Use the same CLI installation as the running server. For an unpublished local checkout, replace `npx kuikly-devtools` with `node /absolute/path/to/kuikly-devtools/bin/kuikly-devtools.js`. Pass `--panel-port` if the panel uses a non-default port.

```bash
npx kuikly-devtools inspect sessions
npx kuikly-devtools inspect logs --pager <pager-id> --query <text> --limit 50
npx kuikly-devtools inspect network --pager <pager-id> --query <url-or-stack> --status 500
npx kuikly-devtools inspect native --pager <pager-id> --query <module-or-method>
npx kuikly-devtools inspect nodes --pager <pager-id> --query <view-or-class>
```

Start with `sessions`, choose a live `pagerId`, then query only the relevant data type. Use `--offset` and `--limit` to page through results. Logs accept `--level` (`i`, `d`, `e`, or `p`) and `--tag`; network accepts `--status` and `--kind`; native accepts `--kind` (`sync`, `async`, or `stream`).

Use an explicit detail lookup only after finding its ID in a search result:

```bash
npx kuikly-devtools inspect network-detail --pager <pager-id> --id <request-id>
npx kuikly-devtools inspect native-detail --pager <pager-id> --id <call-id>
npx kuikly-devtools inspect log-detail --pager <pager-id> --id <log-seq>
npx kuikly-devtools inspect node-detail --pager <pager-id> --id <node-id>
```

Never request the legacy full session endpoint for investigation. Search results contain summaries and body previews. Results at or below 15 KiB are returned as JSON; only a result larger than 15 KiB is written to `<project>/.kuiklyDevtoolTemp/`, with the CLI returning `{ "savedTo": "..." }`. Read that file selectively with line- or field-oriented commands; do not paste the whole file into context. The directory is ignored by Git and remains visible for manual cleanup.

```bash
npx kuikly-devtools inspect clean-temp
```

When the server is unavailable or `sessions` is empty, say that live page data is not attached yet and use `npx kuikly-devtools dev`, `build-js`, `build-apk`, or `gradle -- <task>` to start/reuse the service and make an instrumented build.

## Edit live properties and state

For a user-requested live change, find the target session and node using the searches above, then read `node-detail`. Use the latest node ID from that session; IDs can change when a page reloads. Inspect `node.e`, which lists writable fields and their original Kuikly types:

- `p`: rendered properties and layout attributes.
- `s`: component/view member state.
- `as`: component attr member state.

To fetch state and its writable metadata before editing, use:

```bash
npx kuikly-devtools inspect state --pager <pager-id> --id <node-id>
```

This subscribes to the selected node's state and waits for a device update (up to 20 seconds). The state command replaces the session's current state subscription. For state (`s`/`as`), only edit fields listed in `e[target]`; Kotlin members cannot be dynamically added. For properties (`p`) absent from `e.p`, query the supported-property schema below. Default layout values can be omitted from `p` even when the business set them. For an unclear target or value, resolve that ambiguity before writing; normal read-only investigation should not modify page state.

Send one field edit using JSON for `--value`. Quote the shell argument so the JSON is passed literally. Examples:

```bash
npx kuikly-devtools inspect edit --pager 7 --id 42 --target p --key width --value '120'
npx kuikly-devtools inspect edit --pager 7 --id 42 --target p --key backgroundColor --value '"#80FF0000"'
npx kuikly-devtools inspect edit --pager 7 --id 42 --target p --key margin --value '{"top":10,"right":5}'
npx kuikly-devtools inspect edit --pager 7 --id 42 --target s --key enabled --value 'true'
```

Use values compatible with the reported type:

- `enum:A,B,C`: one of those exact case-sensitive strings, passed as a JSON string.
- `Boolean`: JSON `true` or `false`; numeric types: JSON numbers. Integer types reject fractions and overflow; Long is limited to JavaScript's safe integer range.
- `String` / `Char`: JSON string; Char must contain one UTF-16 code unit.
- `Color` and color properties: a JSON string such as `"#RRGGBB"`, `"#AARRGGBB"`, or `"0xAARRGGBB"`, or a decimal number. Eight-digit formats are ARGB, with alpha first. Leave signed Int, decimal String and Color conversion to the server. String/Color fields also accept native color tokens.
- `space`: one finite number, or an object containing `top`, `left`, `bottom`, `right`; omitted sides become zero.
- A type ending in `?` accepts JSON `null`; other types do not.

The CLI waits for `editResults` from the device. Only `{ok:true}` is confirmed success; the result includes the actual readback value when available. If `readbackUnavailable:true`, fetch `node-detail` or search again: a setter may remove/recreate the node. A device rejection exits nonzero. Timeout/disconnection leaves the outcome uncertain: read the current node before retrying, and do not automatically replay an edit because custom setters may have side effects. `--timeout-ms` can adjust the wait (100–120000 ms).

Report the targeted field and confirmed readback, including any normalization. If verification or continued diagnosis is needed, read just that node rather than the full page snapshot. Changes affect the live page only, are not persisted to business source, and later application updates may overwrite them.

## Set supported properties absent from attr

Find the actual target first: a button background usually belongs to the container parent of its text node. Read its latest node ID, then query:

```bash
npx kuikly-devtools inspect props --pager <pager-id> --id <node-id>
```

The device returns `properties` with semantic `inputType`, constraints, enum values, description, `reported`, and actual `currentValue` when readable. `reported:false` does not prove the business never set the property. Empty properties/reason means this node currently has no supported additions; virtual nodes are excluded. A capability error requires updating the server and rebuilding/reloading the page.

For a property in this schema, prefer the typed setter mode for both additions and subsequent changes:

```bash
npx kuikly-devtools inspect edit --pager 7 --id 42 --target p --key backgroundColor --value '"#80C8FF"' --set-supported
npx kuikly-devtools inspect edit --pager 7 --id 42 --target p --key visibility --value 'false' --set-supported
```

`--set-supported` refreshes schema before submitting once; it never falls back to legacy editing. It accepts only target `p`, only keys supported by that node, and no null values. Boolean inputs are true/false even if legacy p stores 0/1. Numeric colors use ARGB with alpha first; this mode does not accept native theme tokens. Font size input is a logical size; readback can reflect host scaling. Spacing objects replace all sides, omitted sides become zero.

Unknown attributes, arbitrary state members and removal/reset-to-unset are not supported. Do not use null or remove a property cache entry to pretend to restore defaults. For an expired node/schema or uncertain timeout, locate/read the node again and do not automatically replay the write. Report actual acknowledged readback, not the submitted value; effects remain confined to the current runtime instance and business updates may overwrite them.
