# 关键文件

| 路径 | 用途 |
| --- | --- |
| runtime/kotlin/com/ailuoku6/kuikly/devtools/KDevtoolsEditing.kt | 类型构造、属性与布局回写 |
| runtime/kotlin/com/ailuoku6/kuikly/devtools/KDevtools.kt | 状态 setter 注册与执行 |
| runtime/kotlin/com/ailuoku6/kuikly/devtools/KDevtoolsJson.kt | 移除颜色格式转换 |
| runtime/kotlin/com/ailuoku6/kuikly/devtools/KDevtoolsTree.kt | 全量发送、实际变化数和 e 元数据 |
| runtime/kotlin/com/ailuoku6/kuikly/devtools/KDevtoolsSession.kt | 截图树同步、edit 命令/回执 |
| instrumentor/src/main/kotlin/com/ailuoku6/kuikly/devtools/instrumentor/SourceInstrumentor.kt | var setter 生成 |
| src/server/values.js | 服务端颜色转换、编辑校验 |
| src/server/hub.js、src/server/panel.js | 命令排队、错误返回、结果转发 |
| ui/src/components/Inspector.tsx、ElementsPanel.tsx、ui/src/App.tsx | 编辑入口与表单 |
| ui/src/store.ts、protocol.ts、styles.css | 等待回执、协议、样式 |
| test/editing.js、test/smoke.js | 颜色/编辑单测及网络协议测试 |
| test/runtime-editing.py、test/runtime/*.kt | 真实 Kuikly JVM 回归 |
| README*.md、PROTOCOL*.md、ARCHITECTURE.md | 使用范围与协议说明 |

- ui/dist 与 gradle/libs/kuikly-devtools-instrumentor.jar 为 git ignored 的本地产物，均已更新。

2026-09-25 新增/更新：

- `src/client/page-command.js`：AI CLI 命令发送、回执、超时与页面关闭。
- `src/cli.js`：inspect state/edit 参数、JSON 值校验、结果输出。
- `ui/src/editHints.ts`：合法值提示。
- `skills/kuikly-page-inspect/SKILL.md`：AI 修改节点/状态流程。
- `test/inspect.js`：CLI 真连接集成回归。
- `test/runtime/EditingTest.kt`：持续上传导致截图饥饿的回归。
