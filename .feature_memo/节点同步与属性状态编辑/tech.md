# 技术

- runtime Tree.collect(includeAll=true) 不清理 diff cache；changed 仅计实际变化，避免状态重复发送或截图完整树触发循环截图。
- Session 在有 pendingScreenshot 时采全树，full=true；响应编辑命令，结果失败重试，成功后刷新全树。
- SourceInstrumentor 在声明类内生成 var setter，复用已有 dumper；支持 private/observable/custom setter，无 KMP 反射。val 只读占位可覆盖继承同名字段。
- runtime Editing 负责类型检查与 Kotlin 基础类型/Color 实例构建，Attr.setProp 更新渲染属性，FlexNode 更新布局并触发布局请求。
- Hub 入站统一颜色规范化；编辑前按 e 类型恢复字符串、signed Int、Long 或 Color 数值。
- 面板等待 requestId 回执，不乐观修改树。断线、页面关闭、错误和 20 秒超时均结束 pending 状态。
