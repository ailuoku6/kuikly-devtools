# 协议

- 保持 v1，通过可选字段兼容旧 agent。
- Node.e: {p?: {key: type}, s?: {...}, as?: {...}}。旧节点没有 e，因此只读。
- 类型 String/Boolean/Byte/Short/Int/Long/Float/Double/Char/Color，显式 nullable 加 ?；布局 space 与 enum:VALUE1,VALUE2。
- edit 命令：{type:"edit",requestId,id,target:"p"|"s"|"as",key,value}；不合并编辑命令。
- ingest/delta.editResults: [{requestId,ok,error?}]；WebSocket 校验失败 {type:"error",message,requestId}；HTTP 错误 400。
- runtime 发颜色原始数值/十进制字符串/token；server 对外为 0xAARRGGBB。
- 接受 #RRGGBB、#AARRGGBB、0xAARRGGBB、signed/unsigned 十进制；保留 alpha，8 位按 ARGB。
- 带截图的包 full:true，tree.nodes 为上传时全树，tree.changed 为传输节点数；内部 delta.changed 是实际变更数。
