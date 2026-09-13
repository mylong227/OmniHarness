---
'omniharness': minor
---

新增仓库常驻指令加载：支持 AGENTS.md / AGENTS.override.md / CLAUDE.md / CLAUDE.local.md（含 @import 嵌套）与 llms.txt，按用户级/项目级/子目录级分层注入系统上下文（fail-closed：读取失败静默跳过，不阻断主流程）。
