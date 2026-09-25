# 交接

2026-09-25：用户已授权并要求实现新增 attr 未声明属性，首期已完成代码，工作区未提交。入口见 index.md 和 docs/design/新增节点属性技术方案.md。

核心：KDevtoolsPropSchema 注册表支持普通渲染节点基础外观、布局和 TextAttr；inspectProps 返回 schema/token，edit setSupported 使用正式 setter；server 转换 ARGB，设备真实回读。树补充已触达的默认布局值。旧 p/e 存储类型和默认 edit 保持兼容。虚拟节点/未知键/动态 state/恢复未设置不支持。

UI 属性区「＋ 添加属性」，搜索分组及合法值提示，原位编辑注册字段走新模式。CLI inspect props、edit --set-supported；skill 与中英文 README/PROTOCOL 已更新。查询回执仅发原连接，server 生成路由 requestId；token 绑定节点对象/会话，断线不改变存活对象身份，客户端重连重新查询。

验证：真实 Kuikly JVM、server 类型、离线 client/hub 与 panel 路由、UI 事件测试、UI 构建、skill 校验均通过。早期 npm test 全套通过；最终新增真实网络场景受本地端口权限和审批服务 503 阻断。浏览器拒绝 file:// 测试页，视觉及 Android/iOS 真机未验证。详见 changes.md。

交付后需重启新版服务/刷新面板、重新插桩构建加载业务页面，已有项目 skill 用 init-skill --force 更新（覆盖自定义）。本轮未操作外部业务项目或活跃页面；runtime 源码直接参与 Gradle 构建，插桩器无需变更。新增 test:ui 使用 ui 已有 esbuild 依赖。
