---
'omniharness': minor
---

完善度补齐（headless / 权限 / MCP / 检查点）：

- headless 模式：新增 `-p` / `--print` 单次非交互执行，支持 `--output-format json` 机器可读输出；`approval=ask` 在 CI 无 stdin 环境显式失败（避免永久挂起）。
- 多档权限：在 auto/deny/rules/guardian/ask 基础上新增 `plan` 只读档（仅放行读类工具，fail-closed 不漏可变工具）。
- MCP：协议版本对齐 2025-06-18，新增 resources/prompts 能力声明与 resources/list·read·prompts/list·get 方法（未配置后端返回空列表，不伪造）。
- 检查点：新增文件级回滚——checkpoint 同时快照工作区（基于 git 工作树差异），rollback 同时还原对话与代码（对齐 /rewind）。
