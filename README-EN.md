# kuikly-devtools

> 中文文档：[README.md](README.md) ｜ 原理详解：[ARCHITECTURE.md](ARCHITECTURE.md)

A Chrome-DevTools-style inspector for Kuikly (Kotlin Multiplatform) pages. Live view tree with
properties and page-absolute layout, component member variables (including `private` ones), business
logs and network traffic — all streaming into a browser panel while the page runs on a real device.

Instrumentation is **opt-in**. Without the flag your build is byte-for-byte unchanged: no source is
touched, no dependency is added, no instrumented code can reach a release artifact.

### Preview

Elements: view tree + live screenshot; click the image to select the matching node.

![Elements panel: tree and live screenshot](snapshot/shot1.png)

Console: filter by level / tag / keyword, with auto-scroll.

![Console panel: logs and filters](snapshot/shot2.png)

## Quick start

This package is self-contained. The business project does not copy sources, does not add a Gradle
plugin, and does not change `build.gradle.kts`. Instrumentation is an opt-in Gradle **init script**
the CLI injects for that one build.

```bash
# from any Kuikly project root (the directory that has gradlew)
npx kuikly-devtools dev
```

Or install it into the project first:

```bash
npm install -D kuikly-devtools
npx kuikly-devtools dev
```

That single command detects your LAN address, starts both servers, sets up `adb reverse` if a device
is attached, and builds the JS bundle with instrumentation. Then open
[http://localhost:8090](http://localhost:8090) and open the page on the device.

To work from source, clone this repo and build the panel and the instrumentor jar once:

```bash
git clone https://github.com/ailuoku6/kuikly-devtools.git
cd kuikly-devtools
npm install
npm run build          # instrumentor fat-jar + panel bundle
```

Individual steps, if you prefer:

```bash
npx kuikly-devtools serve       # servers only (ingest :8089, panel :8090)
npx kuikly-devtools build-js    # start/reuse services, then build the instrumented JS bundle
npx kuikly-devtools build-apk   # start/reuse services, then build the instrumented hot-reload APK
npx kuikly-devtools gradle -- :app:assembleDebug   # start/reuse services, then run any instrumented task
npx kuikly-devtools inspect sessions  # query attached pages on demand for AI-assisted debugging
npx kuikly-devtools doctor      # resolved paths, ports and network addresses
```

## AI page-inspection skill

The bundled `kuikly-page-inspect` skill lets Codex, Claude Code, and Cursor inspect a live Kuikly
page without loading a full snapshot into the model context. It searches page structure, logs, and
network records incrementally, returning summaries first and a detail only after the matching ID is
known. Run this once from the business project root to create all three project-level skill entries:

```bash
npx kuikly-devtools init-skill
```

- **Codex:** `.codex/skills/kuikly-page-inspect/SKILL.md`
- **Claude Code:** `.claude/skills/kuikly-page-inspect/SKILL.md`
- **Cursor:** `.cursor/skills/kuikly-page-inspect/SKILL.md`

Existing project files are left untouched; use `npx kuikly-devtools init-skill --force` to replace
them with the bundled source at [`skills/kuikly-page-inspect/SKILL.md`](skills/kuikly-page-inspect/SKILL.md).

Start or reuse DevTools with `dev`, `build-js`, `build-apk`, or `gradle -- <task>`, attach the device
page, then query only what is relevant:

```bash
npx kuikly-devtools inspect sessions
npx kuikly-devtools inspect logs --pager 7 --query timeout
npx kuikly-devtools inspect network --pager 7 --query /api/search --status 500
npx kuikly-devtools inspect nodes --pager 7 --query SearchBar
npx kuikly-devtools inspect network-detail --pager 7 --id cb_42
npx kuikly-devtools inspect log-detail --pager 7 --id 42
npx kuikly-devtools inspect node-detail --pager 7 --id 42
```

`logs` supports `--level` and `--tag`; `network` supports `--status` and `--kind`; list searches
support `--limit` (50 by default, 200 maximum) and `--offset`. Search results only contain summaries,
keys, and previews. Results up to and including 15 KiB are returned inline. Only a detail larger than
15 KiB is written to `<project>/.kuiklyPageTemp/`, with the CLI returning a `savedTo` path. Read that
file selectively rather than placing it all in the AI context. The directory is Git-ignored, visible
for manual removal, and can be cleared with `npx kuikly-devtools inspect clean-temp`.

## Panels

- **Elements** — the full declarative tree from `templateChildren()`, so virtual (flattened)
  containers and `ComposeView` boundaries are visible, not just native views. The inspector shows
  a live page screenshot (toImage when the tree changes, at most every 2 s; click the image to
  select the matching node via `f` frames), props (`attr.copyPropsMap()`), page-absolute and
  parent-relative layout, and instrumented state.
- **Components** — only `Pager` and `ComposeView` nodes, for navigating by component instead of by
  view.
- **Console** — every `TMLog` / `KLog` / `println` line, filterable by level, tag and text.
- **Network** — HTTP (`KRNetworkModule` and TDF `network.fetch`) plus long connections
  (`TMLongLinkModule` subscribe/observe and pager-event pushes, QMLink, MQTT), with request
  headers, frames listed like Chrome's WebSocket panel, and one-click copy-as-curl for ordinary
  HTTP.

The ingest server is the archive: logs and requests are stored as they arrive, so opening the panel
later still shows traffic from before the browser connected. Panel Clear only hides the current tab;
the archive is deleted when the Kuikly page itself is destroyed.

Purple tags are `ComposeView`s, `◌` marks a virtual node with no native view, and `S` marks a node
whose member variables can be dumped.

## How it works

```
device                                     dev machine
──────                                     ───────────
Pager  ─┐
tree   ─┼─► KDevtools agent ──POST 300ms──► ingest :8089 ──WebSocket──► panel :8090
bridge ─┘        ▲                              │
                 └────────── commands ──────────┘
```

Three of the four data sources need no instrumentation at all:

- **Tree, props and layout** come from public API: `ViewContainer.templateChildren()`,
  `Props.copyPropsMap()`, `AbstractBaseView.frame` and `convertFrame(frame, null)` for page-absolute
  coordinates. `nativeRef` is the node id.
- **Logs and network** come from `BridgeManager`'s built-in `IBridgeCallObserver`, which sees every
  Kotlin↔Native call: `KRLogModule` for logs, `KRNetworkModule.httpRequest` and TDF `network.fetch`
  (including `HttpService` / `httpGet` / `httpPost`, which wrap it as `KuiklyTDFModule.asyncCall`),
  `TMNetworkModule.fetchMapServer`, `KuiklyTDFModule` wrapping `TMLongLinkModule` (pushes arrive as pager events), plus
  `TMKuiklyLongLinkModule` / `TMKuiklyMQTTModule`, and `FIRE_CALLBACK` to correlate responses.
- **Transport** is Kuikly's own `NetworkModule`, the only HTTP client available identically on
  Android, iOS, HarmonyOS and the JS bundle runtime.

Only two things genuinely require compile-time work, and that is all the instrumentor does:

1. attaching the agent to `@Page` classes without editing business code
2. reading **private** member variables — there is no `kotlin-reflect` on Native or JS, so the read
   has to be generated inside the owning class body

### Instrumentation

A Gradle init script copies `commonMain` into `build/kuikly-devtools/instrumented`, rewrites the copy
and points `commonMain.kotlin.srcDirs` at it. Your real sources are never modified.

The rewriter parses Kotlin with `kotlin-compiler-embeddable` (parser only, never the compiler) and
applies pure offset inserts that **never add a newline**, so line numbers in the instrumented copy
still match the original file and stack traces stay usable.

`@Page` classes get:

```kotlin
init { KDevtools.attachPager(this, "DevToolsTestPage") }
```

Classes rooted at `ComposeView` / `ComposeAttr` / `Pager` get a state dumper appended to the end of
their class body, after all property initialisers:

```kotlin
init {
    KDevtools.registerState(this) {
        val __kdtState = LinkedHashMap<String, Any?>()
        KDevtools.tryPut(__kdtState, "selectedTabForward") { this.selectedTabForward }
        KDevtools.tryPut(__kdtState, "scrollerRef") { this.scrollerRef }  // lateinit: guarded
        __kdtState
    }
}
```

Every field gets its own guarded lambda, so an uninitialised `lateinit` or a throwing getter blanks
out that one entry instead of the whole dump. `println(x)` becomes `KDevtools.printLine(x)`, because
`println` is the one logging path that never reaches the bridge.

Because the instrumentor only parses, its embedded Kotlin version is independent of the version your
project compiles with — the same jar serves a Kotlin 1.7.20 mobile pipeline and a 1.9.23-dev
HarmonyOS one.

Reading member variables is safe with respect to Kuikly's reactivity:
`ReactiveObserver.notifyGetValue` returns early when no dependency collection is in progress, so
dumping `by observable(...)` properties outside a bind block cannot pollute the dependency graph.

## Device reachability

| platform | how the device reaches the host |
| --- | --- |
| Android | `adb reverse tcp:8089 tcp:8089`, set up automatically by the CLI; the device posts to `127.0.0.1` |
| iOS | LAN address baked in at build time |
| HarmonyOS | LAN address baked in at build time |

At runtime the agent tries `127.0.0.1` first and falls back to the compiled LAN address, then locks
onto whichever worked. Plain HTTP to a private address requires a debug build that permits cleartext
traffic.

## Cost

The device walks the tree every sampling interval and sends only nodes whose serialised form changed,
plus removed ids. Logs and network records are buffered on device and flushed every 1.5 s (sooner if
the batch is large, or immediately when a tree/screenshot ingest is already going out). A tick with
no tree change and no pending screenshot does not POST just because a log line arrived. A fully idle
page sends nothing. Member variables are dumped only for nodes
the panel has open. While Elements is open, live page screenshots (`Pager.toImage`) run only when
the tree changed, at most every 2 s, and pause if the browser tab or the preview is hidden. Clicking
the image hit-tests `NodeDto.f`.

The server keeps 20 000 logs and 2 000 network records per page for the page's whole lifetime. The
device only buffers what has not yet been delivered (2 000 logs / 500 requests).

Change the interval from the panel (100 ms – 5 s) or at build time with `--sample`.

## Configuration

| flag | default | meaning |
| --- | --- | --- |
| `--host <ip>` | auto-detected | LAN address baked into the build |
| `--port <n>` | `8089` | ingest port, device → host |
| `--panel-port <n>` | `8090` | browser panel port |
| `--sample <ms>` | `300` | initial sampling interval |
| `--project <dir>` | nearest `gradlew` | Gradle project root |
| `--modules <paths>` | auto | Gradle project paths to instrument (default: any KMP module containing a `@Page`) |
| `--task <name>` | per command | override the Gradle task |
| `--copy-only` | off | reroute sources without rewriting (isolates plumbing problems) |
| `--no-adb` | off | skip the reverse tunnel |

To exclude a file from instrumentation, put `kuikly-devtools:ignore` in a comment anywhere in it.

## Limits worth knowing

- Components that live in a published klib (`TMNestStageCardView` and friends) appear in the tree
  with their props, but their private members cannot be dumped — only sources in the instrumented
  module are rewritten.
- `BridgeManager.addCallObserver` stores one observer per pagerId, so attaching the agent replaces
  any other observer on the same page.
- Opening a node forces `by lazy` properties on that node to initialise, because the dumper reads
  them. Dumps are on demand, so this only happens for nodes you actually inspect.
- The tree is sampled, not recorded frame by frame: changes that appear and disappear between two
  ticks are not captured.
- Screenshots need Kuikly 2.17+ (`DeclarativeBaseView.toImage`). Virtual nodes (`renderView == null`)
  cannot be captured; use Live / **Capture page** for a full-page shot. Click-to-select maps the
  image onto `NodeDto.f` using `ox/oy/ow/oh`. Live skips unchanged trees, backs off if `toImage` is
  slow, and never queues overlapping captures.
- The instrumented sources are a copy. Breakpoints and navigation still work against the original
  file since line numbers match, but editing the copy has no effect.

## Development

```bash
npm install
npm test                    # protocol contract + server smoke + archive-lifetime tests
npm run build:instrumentor  # rebuild gradle/libs/kuikly-devtools-instrumentor.jar (runs its tests)
npm run build:ui            # rebuild the panel bundle
```

`npm test` includes a contract check that reads the `put("...")` keys out of the Kotlin agent and
compares them with the TypeScript types, because the two sides only agree by convention and a rename
on either would otherwise just produce empty panels.

Two ways to work without a device:

- `http://localhost:8090/?mock=1` drives the panel itself from synthetic traffic. Good for pure UI work.
- `npm run simulate` posts to the **real** ingest endpoint with payloads shaped exactly like
  `KDevtoolsSession.upload()` and honours the commands that come back, so diffing, on-demand state
  dumps and sampling changes all go through the genuine loop. Pass `--pager 11` to add a second page.

See [PROTOCOL.md](PROTOCOL.md) for the wire format.

### Publishing to npm

Add an `NPM_TOKEN` secret under Settings → Secrets and variables → Actions. Bump `package.json`
`version`, then push a matching tag:

```bash
git tag v0.1.3
git push origin v0.1.3
```

The tag must be `v` plus the version in `package.json`. GitHub Actions runs tests, builds the
instrumentor jar and panel, then `npm publish`.
