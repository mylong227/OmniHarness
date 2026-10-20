# OmniHarness 核心能力提升落地记录（2026-10-20）

> 对应需求矩阵：[CAPABILITY_UPGRADE_REQUIREMENTS_2026-10-20.md](CAPABILITY_UPGRADE_REQUIREMENTS_2026-10-20.md)
> 对应短板分析：[CORE_CAPABILITY_GAP_ANALYSIS_2026-10-20.md](CORE_CAPABILITY_GAP_ANALYSIS_2026-10-20.md)
> 口径：**不做跑分结论**；以能力闭环 + 工程判据验收。

## 1. 落地清单

### A. 长时执行与恢复（P0）

- `ModelOutput.finishReason` 贯通 OpenAI / Anthropic / Responses / Ollama。
- `StepRunner.requestModel` 输出截断续写（≤3 次；半截 tool_calls 不执行）。
- `ContextCompactor.compact(..., force)` + `StepRunner.invokeWithRecovery`：400 prompt-too-long 强制压缩后重试。
- `StepRunnerDeps.fallbackModel` + `ModelRouter.health-fallback`：529/503 切备用模型。
- `Agent` 默认硬时限 **8h**；`-p` 在 `execCli` 补 1h 缺省；`OMNI_LOOP_MAX_MS` 显式覆盖。
- `TurnRunner.maybeAutoCheckpoint` 每 20 步落事件检查点；`Agent.resumeGuidance` 列出已成功写类调用，防续跑重复。

### B. 上下文保鲜（P0）

- `ContextShapers`：工具结果头尾裁剪 + 旧工具轮剪枝；默认只裁**最新**一条（保前缀缓存），强制压缩路径才 aggressive。
- `TokenEstimatorCalibrator`：median/p90 误差与建议系数。
- `ContextWindowCatalog` 补 Claude 4.6 1M。
- `ContextCompactor` 强制压缩判据。

### C. 交互行动空间（P1）

- `browser_act`：goto/click/type/press/scroll/wait_for/aria_snapshot/console/network；默认 Playwright（复用本机 Chrome），`OMNI_BROWSER_ENGINE=cdp` 显式降级，Playwright 启动失败自动回退 CDP。
- `WebSearchProviders`：Brave / Tavily，按 key 自动注册 `web_search`；无 key 不注册。
- `web_fetch` HTML 正文：优先 `@mozilla/readability` + `linkedom`（可选，Readability 抽主文章、去导航/页脚），失败/过短时回退自研 `HtmlToText`。
- `web_fetch` PDF 文本提取：优先可选依赖 `unpdf`（PDF.js 文本层，MIT，2.1MB，按需 `require`），缺失/失败时回退自研正则；十六进制字符串 `<...> Tj` 已由真 PDF 判据证明“正则读不到、unpdf 能读到”。

### D. 独立验证与纠错（P1）

- `review_diff`：干净上下文、结构化 findings（file:line/severity/evidence）。
- `EvidenceLedger`：有工具结果但全失败 ⇒ `unverified`（无结果不误判）。
- `GoalChecker` 机械证据门：无成功工具不调模型判达成。
- 子代理轨迹在 worktree cleanup 前落父存储。
- reviewer findings 记 `review.findings` 日志。
- `TurnRunner.reviewDigest` + `OMNI_REVIEW_BLOCK=1`：完成声明时对 diff 跑独立审查，blocker/major 回灌一次（默认 advisory）。
- `ProvenanceTracker` + `OMNI_PROVENANCE_GUARD=1`：外部工具输出片段进入写类参数时拒绝。

### E. 互操作（P1）

- `McpProtocolNegotiator` + `McpStatelessClient`：MCP 2026-07-28 无状态（`server/discover` + `_meta`），`OMNI_MCP_PROTOCOL=2026-07-28` 启用；默认 legacy。
- `A2aServer` v1.0：`message/send`、`tasks/get`、`agent/getCard`（AgentCard）。
- `SkillMdCodec` + `--skills SKILL.md`：frontmatter + 正文导入/导出。
- 私有协议注释改名，不再自称 A2A v1.0。

### F. 安全与可观测（P1/P2）

- `WslBwrapSandbox`：Windows 上的 WSL2 + bwrap L3 路径；不可达 fail-closed。
- `ShellCommandPolicy`：`OMNI_NETWORK_ALLOW` 开启时拒 curl/wget/nc/ssh 等带外通道。
- `McpConnector.isAllowed`：`OMNI_MCP_ALLOW` 白名单。
- `OtlpMetricsExporter` + `MetricsCollectingEventPort`：`OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` 开启事件/工具/token metrics。
- `ModelRouter.by-context`：按请求估算排除装不下的模型，取窗口最小者；配置支持 `maxContextTokens`。
- 价格未命中仍由 `budget_status.unpricedModels` 可见（既有）。

## 2. 新增判据

新增/扩展 21 个测试文件、约 41 例（另扩展 `modelAdapters.test` 2 例），覆盖：
`turnRecovery`、`turnReviewGate`、`provenanceTracker`、`contextShapers`、`contextWindowCatalog`、
`contextCompactorForce`、`capabilityActTools`、`browserActE2E`、`a2aV1`、`mcpStateless`、
`mcpProtocolNegotiator`、`mcpAllowlist`、`skillMdCodec`、`wslBwrapSandbox`、`pdfTextExtractor`、
`shellEgressGuard`、`evidenceLedger`、`goalEvidence`、`tokenEstimatorCalibrator`、
`modelRouterByContext`、`otlpMetrics`。

已通过：

- `npm run typecheck`
- `npm run lint`
- `npm run check`（铁律/函数体/依赖）
- `npm run arch:gate -- --strict`（0 新增违规）
- `npm run audit:config-wiring`
- 上述 17 个能力测试文件：**35 例全绿**（第二次收口跑）；首轮 19 文件 **58 例全绿**。
- `node tools/probes/memoryTaskLift.mjs --runs=3`（真实 deepseek-v4-flash）：primer on **2/3**、off **0/3**、lift **+0.67**（单模型采样，非跑分）。

## 3. 已知边界（不是“没做”，是环境/产品依赖）

| 项                     | 状态 | 说明                                                                                   |
| ---------------------- | ---- | -------------------------------------------------------------------------------------- |
| 记忆 primer 任务级 A/B | ✅   | `memoryTaskLift.mjs` 真模型 3 次/档：on 2/3、off 0/3、lift +0.67（单模型采样，非跑分） |
| 浏览器动作真机 E2E     | ✅   | `browserActE2E.test` 真 Chrome：goto→click→ARIA 读到 clicked（无浏览器跳过）           |
| reviewer 自动阻断      | ✅   | `OMNI_REVIEW_BLOCK=1` 时 blocker/major 回灌一次；默认 advisory                         |
| 跨工具 taint 传播      | ✅   | `OMNI_PROVENANCE_GUARD=1` 时外部片段进入写类参数被拒（字符串片段下限，非完整 CaMeL）   |
| IDE/云端/PR 闭环       | ⏸️   | 产品决策，非 core harness 代码欠账                                                     |
| License 档位接功能开关 | ⬜   | 商业化批次                                                                             |

## 4. 依赖择优记录（为什么用/不用成熟库）

| 能力       | 选择                                                                                           | 理由                                                                                                                                                                                                                                                                                                   |
| ---------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| HTML 正文  | **`@mozilla/readability` + `linkedom`（Apache-2.0 / ISC，约 1.1MB，optional + 同步 require）** | 自研 `HtmlToText` 按标签正则清洗，导航/页脚/侧栏会混进正文；Readability 按内容密度抽主文章。`linkedom` 比 `jsdom` 轻（0.9MB vs 5.5MB，无原生依赖）。判据：导航文本被丢弃、正文保留。                                                                                                                   |
| PDF 文本层 | **`unpdf`（MIT，2.1MB，optional + 同步 require）**                                             | 自研正则只认 FlateDecode + `Tj/TJ`；对象流/CMap/字体编码/十六进制字符串会漏。`unpdf` 基于 PDF.js，Node 无 DOM；缺失时自动回退，不产生硬依赖。判据：`<48656C6C6F20504446> Tj` 自研为空、`extractAsync` 得 `Hello PDF`。                                                                                 |
| 浏览器动作 | **`playwright-core` 默认 + 自研 CDP 降级回退**                                                 | Playwright 的 actionability/自动等待/iframe/shadow DOM 是商用交互验证的底线；13.6MB、Apache-2.0、不带浏览器下载（`executablePath` 用本机 Chrome）。默认走 Playwright，启动失败自动回退 CDP；`OMNI_BROWSER_ENGINE=cdp` 可显式降级。真机判据：`browserPlaywrightE2E`、`browserScreenshotTool` 真机 e2e。 |
| OTel       | 保留自研 OTLP JSON 子集                                                                        | 官方 SDK 依赖树/体积远超本仓预算；已有 trace 导出评估与线格式判据（见 `OTEL_EXPORT_EVALUATION_2026-10.md`）。                                                                                                                                                                                          |
| MCP        | 官方 SDK 为主，仅无状态 v2 自研                                                                | 官方 SDK 已是既有准入；2026-07-28 无状态握手官方尚未覆盖，故只补 `McpStatelessClient`，默认仍走 legacy。                                                                                                                                                                                               |
| A2A        | 最小 v1 自研                                                                                   | 只覆盖 `message/send`/`tasks/get`/`agent/getCard` 三个互操作面；官方 SDK 约 4.5MB，等需要完整任务生命周期/多传输时再按 optional 评估。                                                                                                                                                                 |
| SKILL.md   | **`yaml` 2.x（ISC，686KB，零依赖，optional + 同步 require）**                                  | 自研只认单行 `key: value`/`[a,b]`；YAML 数组、带冒号/引号的值、多行 description 会报错。`yaml` 是 YAML 1.2 参考实现、零传递依赖（比 `gray-matter` 的旧 js-yaml 3.x 链更干净）；解析后仍校验 name/description/正文，缺失/失败回退自研。判据：YAML 数组 + `"处理: PDF"` 可解析。                         |
| token 计数 | 字符/4 + 校准器                                                                                | 各厂商 tokenizer 不统一，引单一 tokenizer 会制造“精确的错”；保留可校准估计 + p50/p90 报告。                                                                                                                                                                                                            |

> 结论：**能实质提升且成本可接受的就引**（PDF 引 `unpdf`、网页正文引 Readability/linkedom、浏览器默认引擎引 Playwright、SKILL.md YAML 引 `yaml`）；体积/维护面明显不划算的保留自研，并写明替换触发条件。

## 5. 开关与使用

```bash
# MCP 2026-07-28 无状态（默认 legacy）
OMNI_MCP_PROTOCOL=2026-07-28

# 搜索 provider（有 key 才注册 web_search）
BRAVE_API_KEY=...   # 或 TAVILY_API_KEY=...

# OTLP metrics
OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://127.0.0.1:4318/v1/metrics

# 浏览器动作：默认 Playwright Core（复用本机 Chrome）；显式降级 CDP
OMNI_BROWSER_ENGINE=cdp

# shell 带外通道收口（设置后 curl/wget 等被工具层拒）
--network-allow api.example.com

# Windows L3（WSL2 内需装 bwrap）
--sandbox wsl-bwrap

# SKILL.md 导入
--skills path/to/SKILL.md

# 模型路由（配置文件）
{ "modelRouter": { "strategy": "by-context", "entries": [
  { "model": "small", "maxContextTokens": 32000 },
  { "model": "large", "maxContextTokens": 1000000 }
] } }
```

## 6. 复核命令

```bash
npm run typecheck && npm run lint && npm run check
npm run arch:gate -- --strict && npm run audit:config-wiring
npx vitest run --project node tests/unit/turnRecovery.test.ts tests/unit/contextShapers.test.ts \
  tests/unit/capabilityActTools.test.ts tests/unit/a2aV1.test.ts tests/unit/mcpStateless.test.ts \
  tests/unit/skillMdCodec.test.ts tests/unit/wslBwrapSandbox.test.ts tests/unit/otlpMetrics.test.ts
```

> 全量单测已收口：**582 个文件通过、3598 例通过、7 例跳过**。三处旧失败均已定位：
>
> - `prefixReuseGuard`：**真缺陷**——repo-map 与延迟工具清单各占一条 system 尾消息，首步 3 条、次步公共前缀只有 1；修法 `StepContextBuilder.appendDynamicTail` 合并为**一条**动态尾消息（代码修复）。
> - `launchReadiness`：测试仍按旧签名 `openWhenReady(port)` 断言，代码已为带 token 的 URL 传入 `uiUrlRef`；更新判据（测试滞后于 token 安全修复）。
> - `contextUsagePanelRefresh`：测试仍按旧依赖数组断言，代码已引入去抖 `sessionTick` 刷新信号；更新判据（测试滞后于实时刷新修复）。
