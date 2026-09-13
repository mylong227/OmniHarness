# OmniHarness 完善度审计报告

> 审计日期：2026-09-06｜范围：`D:\deepseek\omniharness` + 2026-09 业界基线
> 口径：**完善度**（能否证明可用、能否对外兼容、工程闭环是否成立），不是功能对对碰。
> 方法：双代理并行广度扫描 → 人工 Read 复核关键项 → 与业界基线对齐。

---

## 0. 先说判读

你这个项目**功能不是不够，是多到溢出了**：516 个 TS 文件 / 58,265 行、Rust 5,936 行、104 个适配器、25 个内置工具、哈希链审计、Prometheus、A2A、RLVR 演化、共振场记忆……单看功能清单，比 Claude Code 还花哨。

真正的问题是三句话：

1. **大量能力停在"纸面可用"**——写了、测了 mock、但从没在真实依赖上跑过，且代码里有 84 处中文诚实标记承认了这点。
2. **规范兼容性已经过期**——MCP 还在用 2026-07-28 之前的 `initialize` 握手；`AGENTS.md` 这个 6 万+ 仓库的行业约定，你全仓零实现（只在两份调研文档里提过"可以读"，然后就没然后了）。
3. **注释说得比做得多**——至少两处核心代码（`shellTool`、`checkpoint`）的注释宣称的能力，实现里根本不存在。这比缺功能更危险，因为它会让下一个读代码的人误判安全边界。

---

## 1. 规模实测（全部来自 find/wc/grep，无估算）

| 指标                                  | 数字                                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| TS 源码（含 tests/web）               | 516 文件 / 58,265 行                                                                             |
| ├─ `src/` 核心                        | 320 文件 / 36,669 行                                                                             |
| ├─ `tests/`                           | 161 文件 / 17,306 行                                                                             |
| ├─ `web/`                             | 34 文件 / 4,298 行                                                                               |
| Rust（`crates/`）                     | 38 文件 / 5,936 行 / 89 个 `#[test]`                                                             |
| 单元测试                              | 149 文件 / 16,152 行 / 890 用例                                                                  |
| 适配器 / 工具 / 端口                  | 104 / 22 / 4                                                                                     |
| 断言分布                              | `assert.equal`(松散 ==) **1467**、`ok` 422、`deepEqual` 148、`throws` 54、`strictEqual` **仅 6** |
| CHANGELOG                             | **2 个版本头，仅 1 个真实版本（0.1.0）**                                                         |
| docs/                                 | 35 文件，**无 ADR**                                                                              |
| 中文诚实标记（占位/降级/近似/不可用） | **84 处**                                                                                        |

---

## 2. 六维成熟度（代理尽调 + 人工更正）

| 维度          | 等级     | 现状                                                                                                                                                                            |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 工程化基建    | 基本合格 | CI 5 job 分层、依赖准入铁律（`scripts/check.mjs`）是亮点；**lint 刻意弱化**（`no-explicit-any` 等全 off）、**format 未进 CI**、hooks 需手动激活、changeset 工具在但**从未滚动** |
| 测试成熟度    | 基本合格 | 有真实 HTTP/FS/子进程测试是加分项；但 **70% 断言用松散 `assert.equal`**、无独立 integration/e2e 层、eval 基线仅 1 个文件锁定                                                    |
| 错误/可观测   | **优秀** | JSON 日志 + AsyncLocalStorage traceId + 错误码 + **真哈希链审计**（`SHA256(prev‖canonical(e))`，非快照摘要）+ Prometheus + /healthz、/readyz。这一维越级成熟                    |
| 文档/API 稳定 | 基本合格 | API 稳定性强制标注（`@beta` 329 / `@public` 28）是亮点；**无 ADR**、docs 偏内部研究笔记                                                                                         |
| 安全          | **薄弱** | 有提示注入防护、哈希链审计；**缺 SSRF 网段屏蔽、secrets 扫描、依赖 CVE 门禁、vault**，CI 安全左移空白                                                                           |
| 规模          | —        | 见上表                                                                                                                                                                          |

---

## 3. 人工复核更正（推翻误报 + 补上漏报）

审计铁律：代理的"未检出"≠不存在，代理也会漏报。这轮两边都发生了。

### 推翻的误报

- ❌ 代理称"所有 spawn 均以数组参数调用，命令注入面较小"——**错误**。`src/adapters/tool/shellTool.ts:6` 用的是 `promisify(exec)`，走 shell 解释器；且 `:26` 的 `handle(call, _context)` 把 context **直接丢弃**，`:29` 超时硬编码 30s。
- ❌ 代理称"`dist/` 目录看起来过期"——误判，那是目录项 mtime；逐文件比对 320 个文件 **0 过期**。

### 补上的漏报（代理都没看的地方）

**① `shellTool.ts` 注释与实现不符 —— 安全边界误导**
注释写"在沙箱边界内执行命令"，实现里**没有任何沙箱调用**。
好消息：`src/core/stepRunner.ts:242` 有统一 `gate.gate()`，`src/mcp/mcpServer.ts:104` 也接了 gate —— 生产主路径**有门禁**，不是真裸奔。
坏消息：工具层自身零防御 = 纵深防御缺失，任何绕过 StepRunner 的调用路径（SDK 直调、内部复用）都是裸奔；且 `exec` 走 shell，配合 `commandCanonicalizer` 的"**脚本无法归一化则整体保留**"降级策略，元字符命令可以做出超出 gate 字符串意图的行为。
**定级：中高。** 修复成本极低（改 spawn 数组 + 接 context + 修注释，半天）。

**② `checkpoint.ts` 是"半截 rewind"**
`rollback()` 只把事件数组写回 session storage —— **只回滚对话，文件系统一个字节都不退**。注释自称"Escape 式安全网"。
业界基线（Claude Code `/rewind`）回滚的是**对话 + 代码**。你这个是 176 行的对话快照。
**定级：P1 功能不完整**，注释夸大。

**③ MCP 规范已过期**

| 项       | 你的实现                              | 2026-07-28 RC 基线                             |
| -------- | ------------------------------------- | ---------------------------------------------- |
| 协议核心 | `initialize` 握手 + `protocolVersion` | **无状态核心，移除握手与 `Mcp-Session-Id`**    |
| 能力     | 仅 `tools`                            | + resources / prompts / sampling / completions |
| 长任务   | 无                                    | Tasks                                          |
| 授权     | 无                                    | OAuth 2.1（`iss` 校验）                        |
| 扩展     | 无                                    | Extensions / MCP Apps                          |
| 代码量   | 701 行 / 7 文件                       | —                                              |
| 测试     | `mcp` 目录 ref=1（近乎零覆盖）        | —                                              |

对新规范 server 的互通性**未验证**。这条是兼容性硬伤。

**④ `AGENTS.md` / `CLAUDE.md` / `llms.txt` 全仓零实现**
`src/` grep 零命中。全仓只在 `docs/LANDSCAPE_RESEARCH_2026.md:152` 和 `docs/PEER_PRODUCT_ROUTES_2026-09-05.md:48` 提过"可读取并转化为 skill 上下文"——**知道有这回事，从没做**。
行业现状：6 万+ 仓库、Linux Foundation 治理，Codex/Cursor/Copilot/Gemini CLI/Devin/Aider 全读。
**定级：P0，修复成本半人日。**

**⑤ headless/CI 模式零命中**
`headless|--print|nonInteractive|ciMode` 在 `src/cli/` 全无。业界（`claude -p` / `codex exec`）这是进 CI 的入场券。

**⑥ 权限模式无多档**
`permissionMode` 零命中，只有 `approval: "rules"`。业界是 `plan/acceptEdits/auto/bypass` 多档 + allow/deny glob。

**⑦ Rust 原生产物过期**
`native/omni_napi.node` 比 `crates` 源码旧约 1 天**且已提交进 git** → `napiE2E` 跑的是旧内核。

**⑧ 永久 skip 的安全断言**
`tests/unit/sandboxElevatedReal.test.ts:26` 无条件永久 skip，被跳过的正是最关键的断言："提权后沙箱不能变成全放行"。`macosSeatbeltSandbox` 零测试。

---

## 4. 与业界 2026-09 基线的差距矩阵

判定口径：**标配** = 没有就明显落后；**加分** = 业界也在摸索。

| 能力域                              | 业界基线（2026-09）         | OmniHarness                                               | 差距      |
| ----------------------------------- | --------------------------- | --------------------------------------------------------- | --------- |
| 分层常驻指令（AGENTS.md/CLAUDE.md） | 6万+ 仓库约定               | **零实现**                                                | 🔴 P0     |
| MCP 客户端 + 2026-07-28 无状态核心  | 全行业标配                  | 旧握手 + 仅 tools                                         | 🔴 P0     |
| headless / CI 模式                  | `claude -p`/`codex exec`    | **零**                                                    | 🔴 P0     |
| 多档权限 + allow/deny glob          | Claude 5 档、Codex 沙箱审批 | 仅 `approval: rules`                                      | 🔴 P0     |
| 会话持久化 / resume / fork          | JSONL + `--resume`/`--fork` | ✅ 有（`--resume`、`--fork`、jsonlStorage）               | 🟢 已达标 |
| 自动 compaction                     | 95% 触发 + `/compact`       | ✅ `contextCompactor.ts`（100 行，需验触发策略）          | 🟡 待验   |
| subagent 独立上下文 + 并行          | 双方 GA，最多 8 并行        | ✅ 有 orchestrator/worktree/toolSubset（615 行）          | 🟡 偏薄   |
| checkpoint + rewind                 | 对话 **+ 代码** 回滚        | ⚠️ 仅对话回滚                                             | 🟠 P1     |
| 审计 + trace + 哈希链               | OTel 导出 / 审计日志        | ✅ 哈希链 + Prometheus（**超配**）                        | 🟢 优秀   |
| 沙箱执行                            | 容器/微VM/seccomp           | ⚠️ landlock/bwrap/seatbelt 全占位，policy/restricted 真实 | 🟠 P1     |
| hooks + skills + 插件               | 全支持                      | ✅ 有                                                     | 🟢 达标   |
| 成本/预算可观测                     | token + 成本面板            | ✅ costBudget / budgetStatusTool                          | 🟢 达标   |
| 浏览器 / computer use               | 预览级                      | **零**                                                    | 🟡 加分项 |
| 企业：SSO/OIDC/审计导出             | 面向企业必备                | ✅ 有 OIDC（仅 mock 验证）                                | 🟡 待真机 |
| RLVR / self-evolving                | 前沿                        | ✅ 已有 `src/evolution/`                                  | 🟢 超前   |

---

## 5. 按 ROI 排序的待办（不是按难度）

ROI 口径：成本 ÷ 消除的风险或落后程度。**前 6 项加起来约 6–8 人日，能把这个项目从"功能炫技"拉到"敢自称生产级"。**

| #   | 项                                                             | 成本    | 为什么排这个位置                                     |
| --- | -------------------------------------------------------------- | ------- | ---------------------------------------------------- |
| 1   | 读取 `AGENTS.md`/`CLAUDE.md`/`llms.txt`                        | 0.5d    | 半人日消除一个行业级兼容性短板，性价比全场最高       |
| 2   | `shellTool` 改 `spawn` 数组 + 接 context + 修撒谎的注释        | 0.5d    | 安全边界误导比漏洞本身更危险；半天消除               |
| 3   | CI 加 `npm audit` + `gitleaks` + SSRF 网段屏蔽                 | 1d      | 安全维从"薄弱"拉到"合格"，且是唯一能自动防回归的手段 |
| 4   | headless/CI 模式（`omni -p`）                                  | 0.5d    | 进 CI 的入场券，也是自证可用的前提                   |
| 5   | MCP 升级 2026-07-28 无状态核心 + resources/prompts + OAuth 2.1 | 2–3d    | 兼容性硬伤，唯一成本较高的 P0                        |
| 6   | 多档权限模式 `permissionMode`                                  | 1–2d    | 自主性控制的业界标配形态                             |
| 7   | 断言 `assert.equal` → `strictEqual` + 分支覆盖率阈值           | 1–2d    | 70% 松散断言是测试质量的硬伤，弱断言等于没断言       |
| 8   | checkpoint 升级为文件级回滚（git worktree/stash 式）           | 2d      | 补上 rewind 的另一半，让"安全网"名副其实             |
| 9   | 重建 Rust native 产物 + 解锁 `sandboxElevatedReal`             | 0.5d    | 消除"跑旧内核 + 关键安全断言永不执行"                |
| 10  | 补 `docs/adr/` + 让 changeset 真正滚动出 CHANGELOG             | 0.5d    | 1 个版本的 CHANGELOG 无法支撑"稳定"叙事              |
| 11  | 建 `tests/integration/` + e2e 层                               | 2d      | 149 个 unit 但没有 e2e，多服务编排零验证             |
| 12  | OTel 导出 + 集中重试/backoff 策略                              | 1–2d    | 可观测最后一公里                                     |
| 13  | vault 密钥管理 / seatbelt 补测试 / 浏览器验证                  | 各 1–2d | P2，按需                                             |

---

## 6. 三条别踩的坑

- **别再往里加新能力了。** 你现在缺的不是功能，是让已有 5.8 万行代码可被信任的证据。每加一个新模块，都是在给"不可验证路径"清单添丁。
- **不要为凑全绿去改安全默认值**（如把默认沙箱从 passthrough 改成拦截）——这是行为变更，需要你本人拍板，得单独拎出来决策。
- **本机编不出/连不上的就直说待真机**（landlock/bwrap/seatbelt、真实 OIDC IdP、真实模型 API）。引入未验证代码比不写更糟——这一点你项目里 84 处诚实标记做得比大多数项目好，别为了好看把它们删掉。

---

_附：业界基线调研全文见 `d:\deepseek\agent-harness-audit-2026.md`（含 20+ 来源链接）。_
