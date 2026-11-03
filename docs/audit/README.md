# 审计出证（Audit Attestation）

> **一句话**：`omniharness audit <会话文件>` 把一次 agent 会话变成**一张可独立复核的报告**——
> 谁在什么时候让 agent 做了什么、改了哪些文件、花了多少 token、哪里失败，全部落在一个
> 离线可开的 HTML 里，并自带哈希链。
>
> 定位来源：[`STRATEGY_2026-11-02.md`](../STRATEGY_2026-11-02.md) §6 的 R4「收缩 + 单点外化」。

---

## 1. 60 秒演示

```bash
npm install
npm run build

# ① 出一条报告（输入可以是 OmniHarness 会话、Claude Code transcript、Codex rollout、ACP 转录）
node dist/src/apps/cli/exec.js audit ~/.omniharness/sessions/sess_xxx.jsonl --out report.html

# ② 用浏览器打开 report.html：页面加载时会自动重算哈希链并显示「链完整 / 不可信」
#    也可以不打开浏览器，直接复核：
node dist/src/apps/cli/exec.js audit verify report.html
# ✓ report.html — 链完整（129 条记录，链头 69ee0c5bbbdd6324…）

# ③ 机器可读：给 CI / 工单系统
node dist/src/apps/cli/exec.js audit verify report.json --json
```

`audit <file>` 是 `audit report <file>` 的简写；输出格式按 `--out` 扩展名推断
（`.html` / `.md` / `.json`），也可用 `--format` 显式指定。

目录批量：

```bash
node dist/src/apps/cli/exec.js audit ~/.omniharness/sessions --out audit-reports/
# 每个会话一份 <sessionId>.audit.html；随后可一次复核整个目录
node dist/src/apps/cli/exec.js audit verify audit-reports
```

---

## 2. 支持的输入

| 来源                   | 典型路径                                       | 识别依据                                       | 说明                                                                        |
| ---------------------- | ---------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------- |
| OmniHarness 会话       | `~/.omniharness/sessions/*.jsonl`              | `type` + `payload` 事件                        | 也认 `session export` 的 `omniharness.session.v1` 信封（单对象 `events[]`） |
| Claude Code transcript | `~/.claude/projects/<project>/<session>.jsonl` | `message` 对象 + `uuid` / `sessionId`          | `tool_use` / `tool_result` / `thinking` / `usage`                           |
| Codex rollout          | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `response_item` / `event_msg` / `turn_context` | `event_msg` 与 `response_item` 的重复消息按去重口径只计一次                 |
| ACP 转录               | 任何 JSONL 化的 JSON-RPC 帧                    | `jsonrpc` / `session/update`                   | 兼容裸帧、`{message}` 包装与 `{frame}` 包装                                 |

识别**只看结构、不看文件名**；认不出时**明确失败**并提示 `--source-format`，绝不产出空报告。

---

## 3. 报告里有什么

| 区块     | 内容                                                                                        | 可复核性                                                                                                     |
| -------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 摘要     | 记录数 / 工具调用 / 工具失败 / 文件数 / 审批数 / 耗时 / token                               | 每个数字都能从记录重算                                                                                       |
| 覆盖率   | `coverage: { recognized, unrecognized }`——载入时间线的记录数 + 解析器明确不认识的来源条目数 | `recognized` 由 verify 机械对账；未识别条目以 `other` 记录保留（口径见 [ATTESTATION.md](ATTESTATION.md) §3） |
| 文件变更 | 路径、触及次数、可得的 `+n/−n`                                                              | 只认写类工具的参数、`apply_patch` 头与 unified diff                                                          |
| 时间线   | 用户 / 助手 / 思考 / 工具调用 / 工具结果 / 审批 / 系统事件                                  | 含 `callId` 与结局；`tool_result` 会回填调用记录的 status                                                    |
| 完整性   | 算法、创世哈希、链头、记录数、输入文件 SHA-256                                              | 浏览器按钮复核载荷链；CLI 追加复核整份文件（含展示层）                                                       |
| 载荷     | 完整 JSON（HTML 为内嵌 `<script type="application/json">`，Markdown 为文末围栏）            | 载荷被改由链检出；展示层被改由文件级自指纹检出                                                               |

### 3.1 哈希链算法（第三方可独立实现）

```
canonical(x)：对象键按 UTF-16 码元升序；省略值为 undefined 的键；数组保持顺序
hash_n     = SHA-256(prev_n + "\n" + canonical(record_n))
prev_1     = "0" × 64
head       = hash_last（空链时 = 创世哈希）
```

报告的 `records[]` 里每条都带 `prev` 与 `hash`；`integrity` 再给 `head` / `count`。
HTML 报告内嵌的复核器就是这个算法的纯 JS 实现（无外部依赖、无网络请求），
`tests/unit/auditVerifierScript.test.ts` 用 Node 侧同一份载荷交叉验证两边算出的链头一致。

### 3.2 文件级自指纹（HTML / Markdown）

只保护载荷还不够：报告是给人看的，**改页面上的一个显示字符**同样能骗过只读链的读者。
所以 HTML / Markdown 还写一个 `artifact.sha256`：

```
tokenized = 报告 JSON 的 artifact.sha256 换成占位标记 "__OH_ARTIFACT_SHA256__"
artifact  = SHA-256(整份文件文本，UTF-8)
```

复核时把摘要换回占位标记、重算整份文本；对不上即判 `artifact`。删掉该字段则判
`artifact-missing`（否则"删字段 + 改展示"就能绕过）。JSON 形态没有展示层，不写该字段。

---

## 4. 诚实边界（读之前先看这一节）

1. **哈希链证明"载荷自发放后未被改动"，不证明"会话本身真实"，也不证明生成者身份。**
   任何拿到报告的人都能重算一条自洽的新链；来源可信要靠留存副本、外部时间戳或另加签名。
   文件级自指纹（§3.2）只是把"改展示层"也纳入检测，**同样不是签名**。
   报告里的 `source.sha256` 把报告与输入文件绑定，但 `verify` 不会去读原文件（离线复核优先）。
2. **格式是 2026-11 的公开快照。** 本机没有安装 Claude Code / Codex，四类格式的判据基于
   公开文档构造的夹具；真实厂商格式漂移时，工具会**明确报"无法识别"**，不会猜着解析。
   上游格式变更后请补夹具再放行。
3. **审批只记源里真有的。** OmniHarness 会话 JSONL 不含审批事件（审批走 serve 的事件桥），
   所以自家会话的"审批数"通常是 0；ACP 的 `session/request_permission` 一问一答会被记录。
4. **不解析 shell 重定向。** `> out.txt`、`tee` 这类写文件不会进文件表——需要真正的 shell
   语法分析，猜错会把"没改的文件"写进报告，比少记更糟。
5. **token 口径随来源。** Omni 取 `model` 事件的 usage；Claude Code 取 `message.usage`
   （`cache_read` 单列，不并入 prompt）；Codex 取 `token_count` 的累计值。
   缺用量时报告写 `null`，不补零。
6. **报告含敏感内容。** 完整 prompt、命令、工具输出与绝对路径都在里面；当前**没有脱敏旋钮**，
   对外发送前请自行评估。
7. **只做单次会话。** 单文件上限 64 MiB、目录上限 2000 个文件、单文件 100k 行；超限即拒绝
   （截断的报告会让复核方误以为"就这些"）。
8. **未识别条目不静默（2026-11-03 起）。** 解析器不认识的来源条目（坏行 / 类型未知 / 非法帧）
   计入报告的 `coverage.unrecognized`，未知类型的条目同时以 `other` 记录原样保留；
   `--strict` 让"有未识别"直接以退出码 1 失败（报告仍生成）。计数口径与边界见
   [ATTESTATION.md](ATTESTATION.md) §3，退出码见 [EXIT_CODES.md](EXIT_CODES.md)。

---

## 5. 代码与判据

| 关注点                 | 文件                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| 数据契约               | `src/apps/audit/auditTypes.ts`                                                                      |
| 规范 JSON / 哈希链     | `auditCanonical.ts` / `auditChain.ts`                                                               |
| 四种来源解析           | `omniSessionParser.ts` / `claudeCodeParser.ts` / `codexSessionParser.ts` / `acpTranscriptParser.ts` |
| 识别与加载             | `auditSourceDetector.ts` / `auditSourceLoader.ts`                                                   |
| 摘要与文件表           | `auditReportBuilder.ts`                                                                             |
| HTML / Markdown / 落盘 | `auditHtmlRenderer.ts` / `auditMarkdownRenderer.ts` / `auditReportStore.ts`                         |
| 复核                   | `auditReportVerifier.ts` + 内嵌 `auditVerifierScript.ts`                                            |
| CLI                    | `src/apps/cli/auditCommand.ts`（`audit report` / `audit verify`）                                   |

判据：`tests/unit/auditParsers.test.ts`、`auditReport.test.ts`、`auditReportChain.test.ts`、
`auditCanonical.test.ts`、`auditVerifierScript.test.ts`、`auditTool.test.ts`、`srcDocRefs.test.ts`
（夹具在 `tests/fixtures/audit/`；`drift-mixed.jsonl` 是"混入 3 条未知类型"的漂移夹具，
`--strict` 与 `coverage` 的正对照都打它）。

---

## 6. 还没做（明确不做，不是遗漏）

- **报告签名**（Ed25519 / OIDC 身份绑定）：需要密钥分发与信任根，超出单机 MVP；哈希链已覆盖
  "完整性"，签名是下一步（`identity` 模块已有 Ed25519 能力）。
- **脱敏旋钮**（路径 / 密钥 / 个人信息的规则化遮蔽）：规则错一次就会漏数据，需要独立设计。
- **Web 工作台入口**：当前只有 CLI；报告本身就是离线 HTML，先验证"有人真的每周看"再加 UI。
- **npm 发布**：本机 `npm whoami` 未登录，`npx` 形态发布后才有；在此之前按上面的 `node dist/...` 跑。
