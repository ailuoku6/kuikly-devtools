# Kuikly DevTools wire protocol (v1)

> 中文版：[PROTOCOL.md](PROTOCOL.md)

Two hops, two shapes:

```
device  --HTTP POST-->  ingest server (:8089)  --WebSocket-->  browser panel (:8090)
        <--commands---
```

The device only ever sends **changed** nodes. The ingest server keeps the authoritative full tree
**and an append-only archive of every log and network record** so a browser that connects late still
gets a complete picture. That archive is deleted only when the device reports `destroyed: true`
(the pager received `DESTROY_INSTANCE`).

## 1. Device to server

`POST http://<host>:<ingestPort>/__kuikly_devtools/ingest`
with `Content-Type: application/json`.

The path is deliberately distinctive: the agent's own uploads travel through the same
`KRNetworkModule` it is tapping, so `KDevtoolsBridgeTap` drops them via the `__kuikly_devtools`
URL marker (and an upload reentrancy flag). Kuikly JSON escapes `/` as `\/`, so matching the
full path against the raw bridge params string is unreliable.

```jsonc
{
  "v": 1,
  "pagerId": "3",              // Kuikly pagerId, the session key
  "sid": "1712-1",            // identity of this attach; late packets after DESTROY are dropped by it
  "page": "DevToolsTestPage",   // Pager.pageName
  "class": "DevToolsTestPage",  // @Page class simple name
  "platform": "android",       // PageData.platform
  "seq": 42,                   // monotonic per session
  "ts": 1755850000000,
  "full": false,               // true => receiver must clear its node map first
  "destroyed": false,          // true => merge this packet's logs/network, then drop the session
  "sampleMs": 500,
  "droppedLogs": 0,            // logs dropped by the device ring buffer since last tick
  "tree": {
    "nodes": [ /* NodeDto, changed only (or all when full) */ ],
    "removed": [12, 13],       // nativeRefs that disappeared
    "total": 812,              // nodes currently in the tree
    "changed": 9
  },
  "logs":    [ /* LogDto */ ],
  "network": [ /* NetworkDto */ ],
  "screenshot": { /* present after a `shot` command or a live frame */ },
  "device":  { /* only present when full === true */ }
}
```

A tick with no tree changes and no pending screenshot is **not sent**, even if logs or network
records are sitting in the buffer. Those are held for 1500 ms (or until 64 logs / 16 dirty
network records) and then flushed as one ingest. A tree delta or screenshot still takes them
along immediately. A fully idle page costs zero traffic.

### Screenshot

Produced by the panel `shot` command, or by `live` (page capture while the Elements panel is
open). Live is **not** a video stream: the device only calls `toImage` when the view tree changed,
at most every 2000 ms (and at least 2× the last capture cost), skips while an ingest is in flight,
and the panel turns `live` off when the browser tab or the screenshot preview is hidden. The
callback is async, so the result rides on a later ingest tick — never inlined in the HTTP response.

`ox/oy/ow/oh` is the captured view's **visible** page-root rect (`convertFrame` minus ancestor
Scroller contentOffset). The panel maps a click on the image to `(ox + fx * ow, oy + fy * oh)`
and hit-tests visual boxes: layout `f` minus ancestor `so`, then `p.transform`, clipped to
overflow / scroller viewports.

| key | meaning |
| --- | ------- |
| `id` | `nativeRef` of the captured view (`Pager` when `shot.id` was omitted / `<= 0`) |
| `ts` | capture timestamp |
| `sample` | `sampleSize` passed to `toImage` (clamped 1..8, default 2; larger = smaller/faster) |
| `data` | `data:image/png;base64,...` on success |
| `err` | set instead of `data` when the view is missing, virtual (`renderView == null`), or `toImage` failed |
| `ox`, `oy`, `ow`, `oh` | page-root origin and size of the captured view |
| `live` | `true` when this frame came from the live loop |

### NodeDto

Keys are short because a full snapshot of a busy page carries thousands of them.

| key  | type      | meaning |
| ---- | --------- | ------- |
| `id` | int       | `AbstractBaseView.nativeRef`, stable for the node's lifetime |
| `pid`| int       | parent `nativeRef`, `-1` for the page root |
| `n`  | string    | `viewName()`, the native component name |
| `c`  | string    | Kotlin class simple name |
| `r`  | bool      | has a `RenderView` (false = virtual / flattened node) |
| `cv` | bool      | is a `ComposeView` (drives the Components panel) |
| `f`  | `[x,y,w,h]` | **layout** frame in page-root coordinates, via `convertFrame(frame, null)` (ignores scroll/transform) |
| `lf` | `[x,y]`   | offset within the dom parent |
| `so` | `[offsetX, offsetY]` | `ScrollerView.curOffsetX/Y` only. A scroll dirties this one node instead of every descendant |
| `p`  | object    | `attr.copyPropsMap()` |
| `hs` | bool      | a state dumper is installed for this node or its attr |
| `s`  | object    | instrumented member variables — only for nodes the panel opened |
| `as` | object    | the same for the node's `ComposeAttr` |

`s` / `as` are omitted unless the panel asked for that node via a `state` command, because dumping
member variables of every node on every tick would be far too expensive.

### LogDto

| key | meaning |
| --- | ------- |
| `seq` | monotonic per session, used for ordering and de-duplication |
| `lv` | `i` info, `d` debug, `e` error, `p` `println` |
| `tag` | recovered from `KLog`'s `[KLog][tag]:message` format, or the instrumented call site |
| `msg` | message text |
| `ts` | `DateTime.currentTimestamp()` |

### NetworkDto

HTTP records are sent twice: once when the request starts, once when it completes. The server merges
by `id`.

Long connections (`kind: "stream"`) create one row on subscribe and afterwards send only new `msgs`;
the server concatenates them by `seq`. The row closes on unsubscribe or page destroy.

| key | meaning |
| --- | ------- |
| `id` | the bridge callback id (or an agent-generated `ll_*` when subscribe is synchronous) |
| `url`, `method` | real URL for HTTP; `longlink://cmd/{cmd}` / `qmlink://…` / `mqtt://{topic}` (`SUB` / `OBS` / `PUB`) |
| `stack` | `KRNetworkModule`, `TDF/network.fetch`, `TMNetworkModule.fetchMapServer`, `TDF/TMLongLinkModule`, `TMKuiklyLongLinkModule`, `TMKuiklyMQTTModule` |
| `req` | request body / subscribe params as a string |
| `hdr` | request headers as a JSON object string. `KRNetworkModule`'s `cookie` is folded in when Cookie is absent |
| `ts` | start timestamp |
| `cost`, `status`, `ok`, `rsp`, `err` | HTTP: completion only. Streams: `status` only once closed |
| `kind` | `stream` for a long-lived subscribe |
| `msgs` | `[{ seq, dir, ts, data }]`, new frames only |
| `frames` | total frames so far |

Captured without extra instrumentation: `KRNetworkModule.httpRequest`, Hippy/TDF `network.fetch`
(including `HttpService` / `httpGet` / `httpPost` which wrap it as `KuiklyTDFModule.asyncCall`),
`TMNetworkModule.fetchMapServer`, TDF `TMLongLinkModule` subscribe/observe (pushes arrive as pager
events such as `poiDetail:longConnect`), `TMKuiklyLongLinkModule`, and `TMKuiklyMQTTModule`.

## 2. Server to device

The HTTP response carries the command queue, so one round trip covers both directions and the device
never needs a second channel.

```jsonc
{ "ok": true, "commands": [ { "type": "full" } ] }
```

| command | payload | effect on the device |
| ------- | ------- | ------------------- |
| `full`  | | next tick sends every node |
| `state` | `ids: [int]` | dump member variables for exactly these nodes |
| `sample`| `value: int` | change the sampling interval (clamped to 100..5000 ms) |
| `clear` | | drop buffered logs and network records |
| `shot`  | `id?: int`, `sample?: int` | capture the page (`id` omitted / `<= 0`) or a node via `toImage` |
| `live`  | `on: bool`, `interval?: int`, `sample?: int` | stream page screenshots when the tree changes (default 2000 ms, sample 4) |

Idempotent commands (`full`, `state`, `sample`, `shot`, `live`) are collapsed in the queue so a
chatty panel cannot build up a backlog. The screenshot itself is delivered on a later ingest, not in
this response.

## 3. Server to browser

WebSocket at `ws://localhost:<panelPort>/ws`.

| message | payload |
| ------- | ------- |
| `hello` | `sessions: [SessionSummary]` on connect |
| `snapshot` | pushed for every existing session on connect; also the reply to `subscribe` |
| `delta` | the device payload, forwarded verbatim plus a `meta` summary |
| `session-added` / `session-removed` | `summary` / `pagerId` (`session-removed` only on page destroy) |

Browser to server:

| message | payload |
| ------- | ------- |
| `subscribe` | `pagerId` |
| `command` | `pagerId`, `command` (same shapes as section 2) |

Panel Clear is a local view action. `clear` / `drop` messages are ignored; the server archive is
deleted only when the device reports `destroyed`.

REST equivalents exist for scripting: `GET /api/sessions`, `GET /api/session?pagerId=`,
`POST /api/command`.
