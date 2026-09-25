# 验证与变更

## 2026-09-24

- 完成 runtime/server/UI 编辑链路，截图全量树与颜色转换迁移，补充中英文协议和使用说明。
- npm test：全部通过（协议、editing、hit-test、blobs、curl、HTTP/WebSocket smoke、history、CLI servers、inspect）。首次失败来自沙箱禁止监听而非真实端口占用；授权执行后通过。
- npm run build --prefix ui：TypeScript + Vite 通过。
- python3 test/runtime-editing.py /Users/ailuoku6/kuiklyProject/KuiklyUI：通过。使用真实 Kuikly common/JVM 源码，验证生成 setter、observable 通知、自定义 setter、Color、nullable、数值边界、布局、截图重发、命令结果/失效节点。
- 插桩 SourceInstrumentorTest：缓存 Kotlin 编译器编译，调用全部 17 个 JUnit 标注测试，均通过。
- git diff --check：通过。
- 本地插桩 JAR 更新后 java -jar 运行夹具，确认产出 registerStateEditor。UI dist 已生成。
- Gradle test fatJar 标准入口未运行成功：需要写全局缓存的执行被自动审批服务两次 503 拒绝。替代编译、测试和本地产物更新均完成。
- 无 Android/iOS 真机或 Native/JS 构建验证；没有执行发布或提交。

## 2026-09-24：编辑入口不可见排查

- 用户反馈看不到编辑入口。新增 Inspector 提示：节点缺 e 时解释需新版插桩并重新加载；有编辑元数据但无可写字段时解释只读范围。
- 当前 8089/8090 服务进程 cwd 为 /Users/ailuoku6/AndroidStudioProjects/kisstate；其 shared/build/kuikly-devtools/instrumented 内已存在 registerStateEditor，不能断言用户未编译。未确认当前设备加载的 Bundle 或服务实际来源。
- 本机会话 GET 被沙箱拦截，提权自动审批两次返回 503，因此未能核验实时节点 e。
- UI TypeScript/Vite 构建通过，ui/dist 已更新；git diff --check 通过。
- 建议先强制刷新面板，用本工作区 CLI 重启服务并重新加载对应 Bundle；若显示缺编辑能力，再重新插桩编译。

## 2026-09-24：改为点击值直接编辑

- 按用户要求移除编辑/应用/取消按钮；可写属性与状态值点击原位输入，hover 虚线边框提示，只读值保持展示。
- Enter 或 blur 自动提交；Esc 取消、Shift+Enter 换行。中文 IME 选字回车不提交；同步 ref 阻止 Enter+blur 重复提交；原值未改不提交。
- 非法 JSON 或服务端/设备拒绝时关闭输入，显示设备合法值与简短错误，未将草稿乐观写入节点。
- 验证：UI TypeScript/Vite build、test/editing.js、test/protocol-contract.js、git diff --check 通过。临时组件事件检查执行实际 Row 代码，覆盖点击、Enter+blur 去重、失焦提交、非法/拒绝恢复、IME、未修改、Esc、只读；通过。未进行真实浏览器视觉验证。
- ui/dist 已重新生成；此项交互修改只需刷新新版面板，不涉及新增 runtime 协议或重新插桩。

## 2026-09-25：实时截图修复、合法值提示与 AI 编辑

- 根因：applyEdit 添加 stateNodeIds 后每个 tick 都上传状态；uploadInFlight 阻止随后 pumpLiveShot，之前仅在 tick 调度，所以实时截图饿死。新增上传成功回调中的 pumpLiveShot，仍遵守 live 开关、in-flight 与间隔。
- 为 Session 注入默认真实 sendPayload，JVM 测试延迟完成上传，覆盖连续两次属性修改的截图调度与暂停后不重启。
- editHints.ts 根据 e 类型提示枚举合法值、Boolean、数值范围、颜色格式/token、space 语法与 null；保持点击编辑、回车/失焦应用。
- 新增 inspect state 与 inspect edit CLI。通过 WebSocket 等待设备结果，输出真实字段读回；拒绝、超时、断线/页面移除非零退出且不重试。state 沿用协议替换订阅列表。
- kuikly-page-inspect skill 更新定位/读取 e/修改/确认结果流程、原始 JSON 值语法、颜色与超时语义。现有外部业务工程 skill 未自动覆盖。
- README 标题：中文“一行命令，让 Kuikly 页面拥有调试能力”；英文“One command to bring debugging to your Kuikly pages”。补充 CLI 用法、中英文协议及架构解释。
- 验证：npm test 全部通过，含实际 HTTP/WebSocket + CLI 子进程测试（数值、颜色转换、state、状态编辑、非法值拒绝、自定义 setter 拒绝、超时不重试）；真实 Kuikly JVM 回归通过；UI TypeScript/Vite build 通过；skill quick_validate.py 通过。
- 本次 runtime 修复需要重新插桩编译并加载设备产物；UI dist 已构建。未做移动端真机截图视觉验证。

## 2026-09-25 支持新增未声明 Attr 属性

- 实现运行时白名单、schema 查询与实例 token、颜色/布尔正式 setter、布局与文本重测量、默认值树补充及直接回读；支持注册字段后续编辑，旧协议兼容。
- 面板添加属性（搜索/分组/合法值提示），Enter/blur 单次提交、Esc/IME 保护；CLI inspect props / edit --set-supported；同步 skill、中英文 README/PROTOCOL。
- 已通过：真实 Kuikly common/JVM 编译及运行回归（包含新增属性/非法值/精确回读/token/Session 命令/实时截图）、server 类型校验、真实 page-command+hub 离线链路、真实 panel 查询路由（含跨连接重复 requestId 隔离）、组件事件逻辑、TypeScript/Vite 构建、skill 校验、协议/hit-test/blobs/curl 及 diff 检查。
- 本轮早期 npm test 全套曾通过；新增 inspect 集成场景后，最终真实端口测试受限：node test/inspect.js 无法绑定端口，自动审批返回 503，未执行提权操作。离线测试不替代真实网络集成。浏览器工具禁止 file:// 测试页，未做视觉走查；未做 Android/iOS 真机渲染验证。
- runtime 通过 Gradle 直接包含源码，无需更改插桩器 JAR；业务需重新构建并加载。尚未重启用户服务、重新构建业务或覆盖外部已安装 skill。
