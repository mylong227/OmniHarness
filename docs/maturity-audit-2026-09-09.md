# OmniHarness 成熟度审计 + UI 对标报告

> 审计日期：2026-09-09 ｜ 方法：双代理并行扫广度 → 主代理逐条 Read 源码钉深度（技能 `codebase-maturity-audit`）
> 诚实边界：本机 Windows 11 / node v22.22.2（`node:sqlite` 可用）/ Rust GNU 工具链在 `~/.cargo/bin`（不在 PATH）/ `bwrap`、`sandbox-exec` 缺失。所有规模数字均 `find`/`wc`/`grep` 实测，非估算。

---

## 0. 结论速览

- **后端（工程化 / 安全 / 可观测 / 文档契约）已达生产级**：真哈希链审计、契约式 `api:check`、SSRF 网关、fail-closed 贯穿全局、无隐藏假绿/TODO 残桩。
- **最大短板集中在 UI**：`web/` 有 36 个源文件、约 5500 行代码，却 **0 测试文件**、被 ESLint 整体忽略、CI 不构建、无障碍标记仅 2 处、错误用 `window.alert` 阻塞。功能面已接近 WorkBuddy 主干，但**工程质量与可访问性是明确 P0 缺口**。
- **若干后端模块长期零测试**（LSA 召回、多个 CLI/config/插件源模块），Rust crate 单测未纳入默认 JS 测试流。

---

## 1. 规模实测

| 区域                       | 文件数 |    行数 | 说明                                                           |
| -------------------------- | -----: | ------: | -------------------------------------------------------------- |
| `src/`（TS 源码）          |    329 |  38,764 | 主力                                                           |
| `crates/`（Rust，7 crate） |     38 |   5,975 | `omni-core` 3,854 行最大                                       |
| `web/src`（UI）            |     36 |   5,498 | **0 测试**                                                     |
| `tests/`（单测/集成）      |    176 |  19,224 | 真实用例约 4,564，断言约 11,587                                |
| `evals/` + `benchmark/`    |      — |       — | 能力基准集存在（`live/bench.mjs`、`recall-codebase-real.mjs`） |
| **合计**                   | ~3,960 | ~51,189 | 测试占源码 ~50%                                                |

---

## 2. 六维成熟度差距矩阵

| 维度                  | 现状（证据）                                                                                                                                                                                                                                                                                   | 成熟方案常态                                                | 等级                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------- |
| **1 工程基建**        | CI（`ci.yml` 6 job：gate/test/security/rust/e2e/wasm）、ESLint v9 扁平、Prettier、自研 pre-commit（`scripts/git-hooks`，非 husky）、覆盖率门禁 `coverageGate.mjs`(80%)、`CHANGELOG.md`(17KB)。**CI 不构建 web**                                                                                | husky+lint-staged、多环境矩阵、覆盖率上传、语义化发布       | **adequate**                                    |
| **2 测试成熟度**      | 真实用例 ~4,564、断言 ~11,587、弱断言 0；分层 unit/integration(1 文件偏弱)/wasm-e2e/smoke/stress + SWE-bench 基准；helper 复用（`ptcScript`、`stressModel`）；eval 集存在但**非 CI 常驻**                                                                                                      | 单测+集成+e2e 均衡、eval 常态化、mutation 测试              | **adequate**                                    |
| **3 可观测性**        | 结构化日志 `logger.ts`（JSON→stderr，受 `OMNI_LOG_LEVEL`）；**traceId 经 AsyncLocalStorage 自动传播**；错误码目录 `errors.ts`(166 引用)；探针 `/healthz`+`/readyz`；retry/backoff 747 处；metrics 320 处                                                                                       | 集中日志+OTel 分布式追踪、Prometheus 导出、熔断、crash 自愈 | **adequate**（缺 OTel/Prometheus 导出、缺熔断） |
| **4 文档 & API 稳定** | JSDoc 块 5,827；成熟度标记 665（`@beta` 293），无 `@deprecated`；**契约式 `api:check`**（`scripts/apiStability.mjs`，CI `npm run api:check` 强制每 export 落 `@public/@beta/@deprecated`）                                                                                                     | 全符号 tsdoc、版本化 API 文档站、deprecation 路线           | **strong**                                      |
| **5 安全**            | CI gitleaks；**SSRF `NetworkEgressGuard`** 默认拦私网/链路本地/169.254/IPv6 且白名单不可覆盖；命令注入走 fail-closed 沙箱+枚举白名单；路径穿越 8,221 处 `resolve/canonicalize`；权限粒度 2,800 处；**审计为真哈希链** `SHA256(prev‖canonical(e))` + `verify()` + `resumeChain()`（非快照摘要） | 密钥 Vault、SSRF 代理、注入阻断、可验证审计链               | **strong**（提示注入仅观测不阻断，见 §5）       |
| **6 规模度量**        | 见 §1                                                                                                                                                                                                                                                                                          | —                                                           | **strong**                                      |

---

## 3. UI 专项对标（Codex / WorkBuddy）

**已存在 UI 面（已核实 `web/src/ui/components/`）：**

- 聊天流 `StreamView.ts`(641 行) + 录入 `Composer.ts`（模型/推理强度/权限三切换、图片与文件附件、`WorkIndicator` 状态条）
- 工具调用可视化强：人话叙述（`ToolCallCard`）、`ProcessCluster` 折叠过程块、产物卡片 `ArtifactCard`（文件/补丁下载+预览）、`liveInputs` 流式参数占位、`graph.progress/done` 驱动 `GraphTab`
- 侧栏 `NavRail` + `RightPanel` 11 个 tab（Tools/Metrics/Changes/Settings/Plugins/Graph/Memory/Profiles/File/Detail）
- 会话管理 `SessionPanel`（`listSessions`/`loadThread`/`newSession`）
- 文件预览 `FileTab` + Markdown 渲染 + 外部链接卡片 `ExternalLinkCards`
- 主题 `[data-theme=light/dark]` + 880px 响应式抽屉，localStorage 持久化

**对标基准：**

- **OpenAI Codex**＝纯终端/CLI，无 GUI → OmniHarness Web **已明显超越**。
- **WorkBuddy**＝聊天 + artifact 面板 + 内联可视化 widget + 文件预览 + 主题 + 发布 artifacts → OmniHarness Web **接近主干**，差距在下方清单。

| 优先级 | 缺口（已核实 file:line）                                                                                                        | 影响                         |
| ------ | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| **P0** | `web/` **0 测试文件**（`find web -name "*.test.*"` = 0）                                                                        | UI 回归完全不可见            |
| **P0** | ESLint 整体忽略 `web/**`（`eslint.config.mjs:15` `ignores:['web/**']`）                                                         | 类型/风格问题无人看守        |
| **P0** | **CI 不构建 web**（无 web job）                                                                                                 | UI 被破坏也不报错            |
| **P0** | 无障碍近乎缺失（全 `web/src` 仅 2 处 `aria/alt` 标记：`Composer.ts`、`NavRail.ts`）                                             | 不符合 a11y 基线             |
| **P1** | 助手文本**非增量流式**：`assistant` 事件整体 `renderMarkdown` 渲染（`StreamView.ts:510-542`，`p.content` 整段，无 token delta） | 无"打字中"体感，长答空白感强 |
| **P1** | **无 UI e2e / 视觉回归**（playwright/cypress 配置 = 0）                                                                         | 与 4,564 后端用例形成反差    |
| **P2** | 失败用 `window.alert` 阻塞（App.ts:426/437/459/496/518 等共 **7 处**）                                                          | 体验割裂、无法内联恢复       |
| **P2** | 无 artifact 画廊/分享链路：`artifactFromTool` 仅 `write_file`/`apply_patch`（`StreamView.ts:224-231`）                          | 缺 WorkBuddy 式可分享产物面  |
| **P3** | 无命令面板/快捷键；权限仅为下拉切换；Settings 单 tab 无细粒度矩阵                                                               | 专业度不足                   |

---

## 4. 主代理亲自核实的更正（推翻/修正代理结论）

- **代理路径误报（已修正）**：代理报 `web/src/ui/StreamView.tsx`，实为 `web/src/ui/components/StreamView.tsx`（缺 `components/` 段）。内容结论有效，仅路径修正。
- **`window.alert` 次数上修**：代理报 4 处，实测 **7 处**（App.ts:426/437/459/496/518 + 另 2 处），缺口更严重。
- **"无隐藏残桩"被证实**：`grep "TODO\|FIXME\|not implemented"` 在 `src` 命中 **0**（此前带 `placeholder` 关键字的 3 处全为 CLI 默认占位 `'goal-placeholder'`，非真桩）。代码诚实度高。
- **零测试模块被坐实**：`lsaRecall.ts`(284) / `cliDataCmds.ts`(569) / `configBuilders.ts`(252) / `registrySources.ts`(293) 在 `tests/` 中 **0 引用**，确为长期无人测。
- **OS 沙箱诚实 fail-closed 被证实**：Linux/macOS bwrap/seatbelt 在本机缺失时返回 `None` 走 `UnsupportedSandbox`/`passthrough`，**无静默放行**（`sandboxManager.ts`）。Windows RestrictedToken 经预编译 `native/omni_napi.node` 真实可加载。

---

## 5. 现存不足清单（按严重度）

### P0（阻断级 / 必须修）

1. **Web UI 零测试 + 被 ESLint 忽略 + CI 不构建** → UI 质量完全失控，任何破坏静默合入。
2. **Web 无障碍基线缺失**（2 处 a11y 标记）→ 不满足基本可访问性，且是合规/专业门槛。

### P1（高）

3. **助手文本非增量流式**（`StreamView.ts:510-542`）→ 长答无体感，建议接 token delta / SSE 增量。
4. **无 UI e2e / 视觉回归**（playwright=0）→ 无法守住交互回归。
5. **后端零测试模块**：`lsaRecall`、`cliDataCmds`、`configBuilders`、`registrySources`（合计 ~1,400 行）无测试。
6. **Rust crate 单测未纳入默认测试流**：需手动 `cargo` PATH + `cargo test`；~10 个 `.rs` 测试文件 + Windows RestrictedToken Rust 实现默认不被跑。
7. **HF 本地 embedding 权重未实测**：`transformersEmbedding.test.ts` 仅测构造器（注释明示"不触发模型下载"），召回质量本机不可验（fail-closed 回退 BM25）。

### P2（中）

8. **提示注入仅观测不阻断**（`src/security/promptInjectionGuard.ts`）→ 成熟方案应可配置阻断/隔离。
9. **可观测性缺 OTel/Prometheus 导出 + 熔断** → 无法对接生产监控栈。
10. **`window.alert` 阻塞式失败**（7 处）→ 改为内联错误条/Toast（`ToastService` 已存在，可复用）。
11. **无 artifact 画廊/分享面** → 产物价值未释放。

### P3（低）

12. 无命令面板/快捷键；权限仅下拉；Settings 无细粒度矩阵。
13. CI 未含多环境矩阵 / 覆盖率报告上传 / 语义化发布的完整链路（husky/lint-staged 自研等价物可接受）。

---

## 6. 按 ROI 排序的待办（建议下一步）

| 优先级 | 项                                                                                     | 成本  | 说明                                           |
| ------ | -------------------------------------------------------------------------------------- | ----- | ---------------------------------------------- |
| 1      | **CI 增加 web 构建 job + ESLint 取消忽略 web + 加 `web` 单测门禁**                     | 低    | 一票否决级，先把 UI 纳入看守                   |
| 2      | **Web 补最小单测骨架**（EventStream 解析、StreamView 渲染快照、Composer 状态）         | 低-中 | Vitest + @testing-library，先锁住关键路径      |
| 3      | **a11y 基线**：role/aria-label/live-region/键盘焦点 + 色对比                           | 中    | 先在 `NavRail`/`Composer`/`ApprovalModal` 补齐 |
| 4      | **`window.alert` → 内联 Toast/错误条**（复用既有 `ToastService`）                      | 低    | 直接替换 7 处                                  |
| 5      | **助手增量流式**：SSE token delta 渲染                                                 | 中    | 改 `App.handleEvent` + `StreamView` 文本累加   |
| 6      | **后端零测试模块补单测**（lsaRecall / cliDataCmds / configBuilders / registrySources） | 中    | 先 cliDataCmds、configBuilders（纯逻辑易测）   |
| 7      | **Rust 测试接 CI**：设 `PATH` + `cargo test` job                                       | 低    | 解锁 ~10 个 Rust 测试                          |
| 8      | **提示注入可配置阻断** + **OTel/Prometheus 导出 + 熔断**                               | 高    | 生产对接项，排期靠后                           |

---

## 7. 总评

OmniHarness 的**能力与后端工程化已明显领先同类自研 Agent Harness**（真哈希链审计、契约式 API 稳定、fail-closed 安全范式、~4,564 真实用例），**短板高度集中于 UI 的工程化与可访问性**——而这恰恰是 ROI 最高、修复成本最低的一类（补 CI web job + 单测骨架 + a11y 基线，几乎全是低成本高杠杆动作）。对标 Codex（纯终端）已超越；对标 WorkBuddy（聊天+artifact+可视化+主题）功能面接近，差在测试/e2e/分享面/a11y 这几项"工程化收口"。

**建议**：先执行待办 #1–#4（P0/P1 中低成本的 UI 收口），再补 #5–#7（流式/e2e/后端零测试模块），#8 排生产对接期。
