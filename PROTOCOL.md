# Kuikly DevTools 通信协议（v1）

> English: [PROTOCOL-EN.md](PROTOCOL-EN.md) ｜ 使用文档：[README.md](README.md)

两跳、两种形态：

```
设备  --HTTP POST-->  ingest 服务 (:8089)  --WebSocket-->  浏览器面板 (:8090)
      <--commands----
```

设备只发**变更过的**节点。ingest 服务保存权威全量树、以及该页生命周期内的**全部日志和网络请求**，所以后连上来的浏览器也能拿到完整状态。日志和网络只在设备上报 `destroyed: true`（页面 `DESTROY_INSTANCE`）时删除。

---

## 一、设备 → 服务

```
POST http://<host>:<ingestPort>/__kuikly_devtools/ingest
Content-Type: application/json
```

这个路径故意起得很有辨识度：agent 自己的上报也走它正在监听的那个 `KRNetworkModule`，`KDevtoolsBridgeTap` 靠 URL 里的 `__kuikly_devtools` 标记（以及上传重入标志）把自己的请求丢掉，否则会自我递归。注意 Kuikly 的 JSON 会把 `/` 写成 `\/`，所以不能在未解析的 bridge 参数字符串上匹配完整路径。

```jsonc
{
  "v": 1,
  "pagerId": "3",              // Kuikly pagerId，会话主键
  "sid": "1712-1",            // 本次 attach 的会话身份；DESTROY 之后迟到的包靠它丢掉
  "page": "DevToolsTestPage",   // Pager.pageName
  "class": "DevToolsTestPage",  // @Page 类的 simpleName
  "platform": "android",       // PageData.platform
  "seq": 42,                   // 会话内单调递增
  "ts": 1755850000000,
  "full": false,               // true 表示接收方要先清空节点表
  "destroyed": false,          // true：页面已销毁，服务端合并本包日志/网络后删除该会话
  "sampleMs": 300,
  "droppedLogs": 0,            // 上次上报以来设备环形缓冲区丢掉的日志条数
  "tree": {
    "nodes": [ /* NodeDto，只含变更节点；full 时是全量 */ ],
    "removed": [12, 13],       // 消失的 nativeRef
    "total": 812,              // 当前树里的节点总数
    "changed": 9
  },
  "logs":    [ /* LogDto */ ],
  "network": [ /* NetworkDto */ ],
  "screenshot": { /* `shot` 或 live 循环完成后出现 */ },
  "device":  { /* 仅当 full === true 时出现 */ }
}
```

一个 tick 如果树没变、也没有待上报的截图，**不会因为刚多了一条日志就发出去**。日志和脏网络记录在设备侧先攒着，1500ms（或日志满 64 条 / 脏网络满 16 条）再打成一次 ingest；如果这个 tick 本来就要发树或截图，则顺带带上。完全空闲的页面零流量。

### Screenshot

面板发 `shot`，或打开 Elements 后的 `live`。Live **不是**视频流：树没变就不调用 `toImage`，默认最多
每 2000ms 一帧（并且至少间隔上一次耗时的 2 倍），ingest 在飞时跳过。面板在浏览器标签页隐藏或截图
预览滚出视口时会关掉 `live`。`DeclarativeBaseView.toImage(DATA_URI)` 回调异步，结果挂在后续 ingest 上。

`ox/oy/ow/oh` 是被截图 view 相对页面根的矩形，单位与 `NodeDto.f` 相同。面板把点击换算成
`(ox + fx * ow, oy + fy * oh)` 再对节点树做命中测试。

| key | 含义 |
| --- | --- |
| `id` | 被截图 view 的 `nativeRef`（`shot.id` 省略或 `<= 0` 时是页面根） |
| `ts` | 截图时间 |
| `sample` | 传给 `toImage` 的 `sampleSize`（限制 1..8，默认 2；越大图越小、越快） |
| `data` | 成功时的 `data:image/png;base64,...` |
| `err` | 找不到 view、虚拟节点（`renderView == null`）或 `toImage` 失败时出现，此时没有 `data` |
| `ox` / `oy` / `ow` / `oh` | 被截图 view 相对页面根的原点与宽高 |
| `live` | 来自 live 循环时为 true |

### NodeDto

字段名很短是刻意的：一次全量快照会带上几千个节点。

| key | 类型 | 含义 |
| --- | --- | --- |
| `id` | int | `AbstractBaseView.nativeRef`，节点生命周期内稳定 |
| `pid` | int | 父节点的 `nativeRef`，页面根节点为 `-1` |
| `ci` | int | 在父节点 `templateChildren()` 中的下标，用于让面板按 DSL 顺序排列兄弟节点 |
| `n` | string | `viewName()`，原生组件名 |
| `c` | string | Kotlin 类的 `simpleName` |
| `r` | bool | 是否有 `RenderView`（false 表示虚拟 / 被扁平化的节点） |
| `cv` | bool | 是否是 `ComposeView`（驱动 Components 面板） |
| `f` | `[x,y,w,h]` | **相对页面根节点**的坐标，由 `convertFrame(frame, null)` 计算 |
| `lf` | `[x,y]` | 相对 dom 父节点的偏移 |
| `p` | object | `attr.copyPropsMap()` |
| `hs` | bool | 该节点或其 attr 装了状态 dumper |
| `s` | object | 插桩生成的成员变量，**仅面板展开的节点才有** |
| `as` | object | 同上，对应该节点的 `ComposeAttr` |

`s` / `as` 只在面板通过 `state` 命令要求过之后才带上——每帧 dump 全树的成员变量代价太高。

`ci` 存在的原因：全量快照是按 DFS 顺序发的，但增量到达顺序任意，接收方的 Map 插入序不再是文档序，所以需要显式的兄弟下标。

### LogDto

| key | 含义 |
| --- | --- |
| `seq` | 会话内单调递增，用于排序和去重 |
| `lv` | `i` info、`d` debug、`e` error、`p` `println` |
| `tag` | 从 `KLog` 的 `[KLog][tag]:message` 格式反解，或来自插桩的调用点 |
| `msg` | 消息正文 |
| `ts` | `DateTime.currentTimestamp()` |

### NetworkDto

HTTP 发两次：请求发起时一次，回包完成时再一次。服务端按 `id` 合并。

长连接（`kind: "stream"`）订阅时建一行，之后每次推送只发新增 `msgs`；服务端按 `seq` 拼接，unsubscribe / 页面销毁后该行才变成 closed。

| key | 含义 |
| --- | --- |
| `id` | bridge 的 callbackId，也就是把请求和回包关联起来的东西（长连接没有回调时由 agent 生成 `ll_*`） |
| `url` / `method` | HTTP 为真实 URL；长连接为 `longlink://cmd/{cmd}` / `qmlink://…` / `mqtt://{topic}`，method 为 `SUB` / `OBS` / `PUB` |
| `stack` | `KRNetworkModule`、`TDF/network.fetch`、`TMNetworkModule.fetchMapServer`、`TDF/TMLongLinkModule`、`TMKuiklyLongLinkModule`、`TMKuiklyMQTTModule` |
| `req` | 请求体 / 订阅参数（字符串） |
| `hdr` | 请求头 JSON 字符串。`KRNetworkModule` 的 `cookie` 会并入其中（若尚未有 Cookie 头） |
| `ts` | 发起时间戳 |
| `cost` / `status` / `ok` / `rsp` / `err` | HTTP 仅完成时出现；长连接关闭时才带 status |
| `kind` | `stream` 表示长连接订阅 |
| `msgs` | `[{ seq, dir: "up"\|"down", ts, data }]`，每次上报只含新增帧 |
| `frames` | 该订阅累计帧数 |

HTTP 无需插桩：`KRNetworkModule.httpRequest`、Hippy/TDF `network.fetch`（含 `HttpService` / `httpGet` / `httpPost`，它们包成 `KuiklyTDFModule.asyncCall("network","fetch")`）、`TMNetworkModule.fetchMapServer`。

长连接数据来源（与 kuiklyPoi 一致，无需插桩）：

- `KuiklyTDFModule.syncCall/asyncCall("TMLongLinkModule", subscribe\|observe\|unsubscribe)`，推送走 pager 事件（如 `poiDetail:longConnect`、`poiIndex:mcpLongConn_*`）
- `TMKuiklyLongLinkModule`（QMLink）subscribe 的 keep-alive 回调
- `TMKuiklyMQTTModule` publish / subscribe

**完成时也会重发全部请求字段。** 接收方按 id 合并，并且拒绝用空值覆盖已知值——所以重发既便宜，又能保证一条已完成的记录不会变成"匿名行"（这个坑是实测时暴露出来的）。

TDF 链路的请求会注册成功和失败两个回调。agent 把记录按成功回调 id 归档，同时记一条 `失败回调 id → 成功回调 id` 的别名，否则**失败的请求会永远停在 pending**，而那恰好是最需要看的情况。

---

## 二、服务 → 设备

命令挂在 HTTP 响应体里回传，一次往返覆盖双向，设备不需要第二条通道。

```jsonc
{ "ok": true, "commands": [ { "type": "full" } ] }
```

| 命令 | 载荷 | 设备侧行为 |
| --- | --- | --- |
| `full` | | 下一个 tick 发全量节点 |
| `state` | `ids: [int]` | 只为这些节点 dump 成员变量 |
| `sample` | `value: int` | 改采样间隔（限制在 100~5000ms） |
| `clear` | | 丢弃已缓冲的日志和网络记录 |
| `shot` | `id?: int`，`sample?: int` | 整页（省略 `id` 或 `<= 0`）或指定节点走 `toImage` 截图 |
| `live` | `on: bool`，`interval?: int`，`sample?: int` | 树有变化时才整页截图（默认 2000ms，sample 4） |

幂等命令（`full` / `state` / `sample` / `shot` / `live`）在队列里会被折叠，避免面板操作频繁时堆积。截图本身在后续 ingest 到达，不在本次响应里。

---

## 三、服务 → 浏览器

WebSocket：`ws://localhost:<panelPort>/ws`

| 消息 | 载荷 |
| --- | --- |
| `hello` | 连接建立时给出 `sessions: [SessionSummary]` |
| `snapshot` | 连接时对每个已有会话立刻推送一份；之后也可回应 `subscribe` |
| `delta` | 原样转发设备载荷，额外附带 `meta` 摘要 |
| `session-added` / `session-removed` | `summary` / `pagerId`（`session-removed` 只在页面销毁时出现） |

浏览器 → 服务：

| 消息 | 载荷 |
| --- | --- |
| `subscribe` | `pagerId`（再要一份权威快照；连接时已经推过则不必等它） |
| `command` | `pagerId`、`command`（形状同上一节） |

面板上的 Clear 只清本标签页的视图，**不会**让服务端丢掉历史；`clear` / `drop` 消息会被忽略。服务端档案只在设备上报 `destroyed` 时删除。

也有 REST 等价接口，便于脚本化：`GET /api/sessions`、`GET /api/session?pagerId=`、`POST /api/command`。

---

## 四、兼容性约定

`v` 字段是协议版本。Kotlin agent 与 TS 面板是两套独立代码，只靠字段名约定对齐，所以仓库里有一个契约测试（`test/protocol-contract.js`）直接从 Kotlin 源码里抓 `put("...")` 的 key 与 TS 类型比对。改协议时：

1. 改 Kotlin 侧（`KDevtoolsSession.kt` / `KDevtoolsTree.kt` / `KDevtoolsLog.kt`）
2. 改 `ui/src/protocol.ts`
3. 更新 `test/protocol-contract.js` 里的期望字段集
4. 同步本文档和 [PROTOCOL.md](PROTOCOL.md)

漏掉第 2 或第 3 步，`npm test` 会直接失败，而不是让你在面板上看到一片空白。
