# 节点同步与属性状态编辑

- 状态：done（实现与本地验证完成；尚未做移动端真机验证）
- 更新日期：2026-09-25
- 工作目录：kuikly-devtools
- 最新补充：修复编辑后实时截图调度；补充合法值提示；AI skill/CLI 支持 state/edit；更新中英文 README 标题。
- 当前结果：截图附完整树；属性与状态点击值直接编辑，Enter/失焦应用，非法值恢复；颜色展示和回写转换在 server 完成。

## 文档

- [需求与范围](brief.md)
- [技术实现](tech.md)
- [协议](protocol.md)
- [关键文件](files.md)
- [决策](decisions.md)
- [验证记录](changes.md)
- [交接](handoff.md)
- [项目记录偏好](../recording-preferences.md)

## 使用与后续

- 本地 UI dist 和插桩 JAR 已更新；重新插桩编译并打开业务页面后出现编辑入口。
- 后续若有设备，可验证 Android/iOS 原生渲染实际效果；当前 JVM 使用真实 Kuikly 源码通过。
