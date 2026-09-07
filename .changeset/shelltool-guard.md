---
"omniharness": patch
---

shell 工具加固：绑定 `workspaceRoot` 限制工作区外路径、增加最大输出长度护栏与超时可配、修正此前与实现不符的「沙箱内执行」注释（实际经统一门禁 `ToolGate.gate` 拦截，工具层不再声称自带沙箱隔离）。
