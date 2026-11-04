# 你的 agent 到底改了什么？——给 agent 会话做一份「可交给第三方」的出证报告

> **状态：草稿待发布**（PLAN_2026-11.md P2 T2.3；计划发 V2EX / 掘金 / HN ≥ 2 处，
> 发布动作与「是否用真实会话做配图」待拍板）。本文所有数字均为实测，出处见文末，
> 可逐条复核——这本身就是文章想主张的那件事。

---

## 一、问题：agent 跑完就散场

现在让 agent 干活的人越来越多，但「干完之后」留不下任何可以**交给别人看**的东西：

- 会话转录散在各自的家目录里（`~/.claude/projects/...`、`~/.codex/sessions/...`），
  格式各家不同，第三个人打开只能靠脑补；
- 「它到底改了哪些文件、跑过哪些命令、失败了几次」的答案是一堆截图——截图可以 P，
  复述可以编；
- 真要把这段会话拿给内审、法务、客户看，第一反应是**不敢**：里面有密钥、有绝对路径、
  有你没想公开的 prompt。

一句话：**agent 的执行过程今天没有出证形态**。日志是给自己 debug 的，不是给第三方复核的。

## 二、方案：一条命令，一份自带哈希链的报告

`omniharness audit` 把一次 agent 会话变成一份**单文件 HTML**（离线可开、零外部资源）：

```bash
npx -y @mylong227/omniharness audit <会话文件.jsonl> --out report.html
npx -y @mylong227/omniharness audit verify report.html   # exit 0 = 自生成起未被改动
```

四类来源都认（OmniHarness / Claude Code transcript / Codex rollout / ACP 转录），报告里有
时间线（谁在什么时候让 agent 做了什么）、文件变更表（`+n/−n`，只认写类工具与 unified
diff，不猜）、token 口径、以及两层完整性：

1. **载荷哈希链**：`hash_n = SHA-256(prev_n + "\n" + canonical(record_n))`——改一条记录、
   删一条、换顺序，都会在对应位置断链并给出下标；算法是公开的，第三方可以逐字节重算；
2. **文件级自指纹**：整份文件（含展示层）的 SHA-256——**只改页面上的一个显示字符、
   不动内嵌 JSON** 也会被判红。这是出证工具与「好看的报表」的分界线。

60 秒看效果（本机实录，见 [demo-transcript.txt](demo/demo-transcript.txt)）：

```
═══ ① 出证：audit <会话文件> --out report.html
审计报告已生成：…/demo-report.html
  记录 8 · 工具 1 · 失败 1 · 文件 1 · token 120 · 未识别 0 · 脱敏 off · 链头 b32b6a93ae6a74fb…

═══ ② 复核：audit verify report.html（应显示「链完整」，exit 0）
✓ … — 链完整（8 条记录，链头 b32b6a93ae6a74fb…）

═══ ③ 篡改：改报告里一个显示字（演示报告 → 伪造报告），verify 必须变红
✗ … — 报告字段：artifact（报告可能被改动，不可作为证据）
✓ ③ 通过：一个显示字都瞒不过文件级自指纹（exit 1 = 证据失败）
```

## 三、三个容易被问「这不就是报表吗」的点

**① 报告敢不敢承认自己没看全？** 会话格式会漂移。解析器遇到不认识的条目（坏行、未知
类型、非法帧）不会静默丢弃——计入报告头的 `coverage.unrecognized`，同时把原始载荷以
`other` 记录保留在时间线里；`--strict` 让「有未识别」直接以退出码 1 失败。报告先回答
「我覆盖了多少」，再谈内容。

**② 报告敢不敢发出去？** 完整 prompt、密钥、绝对路径都在会话里。`--redact
off|paths|secrets|all`（缺省 **off**，证据保真优先）把绝对路径遮成「末两段 + 原值哈希
前 8 位」、密钥遮成稳定标记——**同一个值同一个标记**，跨记录仍可交叉比对；`verify`
会按报告头声称的替换次数对账，删脱敏痕迹与篡改同罪。边界也写在文档里：这是尽力而为的
遮蔽，不是 DLP；工作区根的标记可能仍含项目名。

**③ 数字敢不敢被改？** 摘要里每个"等于记录数"的数字（`summary.total`、
`coverage.recognized`、`redaction.hits`）都会被 `verify` 独立重算对账——包括浏览器里
打开报告时页面内嵌复核器的同口径检查。JSON 形态没有展示层自指纹，这三处对账就是它
的机械防线，边界在文档里写明而不是含糊带过。

## 四、诚实边界（本文最想强调的一节）

- 哈希链证明「报告自生成后未被改动」，**不证明会话本身真实**，也不证明生成者身份——
  任何拿到报告的人都能重算一条自洽的新链。要来源可信，需要签名（Ed25519，按外部信号
  后上）或外部时间戳；
- 四类格式的判据基于公开文档构造的夹具（本机未装 Claude Code / Codex），**未在真实厂商
  文件上复核**——格式漂移时工具会明确报「无法识别」，不会猜着解析；
- 退出码是有正式契约的（`0` 全部成功 / `1` 证据失败 / `2` 用法错误），每一条都对应判据，
  改语义必须同时改契约文档与判据。

## 五、Abstract（EN）

Agent sessions today leave nothing that can be _handed to a third party_: transcripts are
scattered across vendor-specific formats, and "what did it actually change" is answered with
screenshots. `omniharness audit` turns one session (OmniHarness / Claude Code / Codex / ACP)
into a self-contained HTML report with a SHA-256 hash chain over every record, plus a
whole-file fingerprint that catches a single altered display character. Unrecognized source
entries are counted and preserved instead of silently dropped (`--strict` fails on them);
optional redaction (`--redact paths|secrets|all`, default off) masks paths and secrets with
stable, value-derived markers whose count is cross-checked by `audit verify`. Exit codes are
a documented contract enforced by tests. Zero runtime dependencies, offline-friendly, ~77 KB
standalone binary. Honest limits: integrity only — not authenticity, not a DLP tool, and
vendor formats are verified against public-snapshot fixtures only.

## 六、数字与出处（全部可复核）

| 数字          | 值                                                  | 出处                                                          |
| ------------- | --------------------------------------------------- | ------------------------------------------------------------- |
| 真实会话实测  | 129 记录 / 27 工具调用 / 456,337 token / 6 分 45 秒 | 项目看板 §207.4                                               |
| 独立 bin 体积 | 78,752 字节（判据 ≤ 307,200，fail-closed）          | 看板 §210.2                                                   |
| 全仓测试      | 726 文件 / 4,486 过（coverage 聚合 85.99%）         | 看板 §209.2                                                   |
| audit 族判据  | 10 文件 / 73 例（含篡改正对照）                     | `tests/unit/`（auditRedactor / auditTool / auditParsers / …） |
| 演示实录      | 三段全符退出码契约                                  | [demo-transcript.txt](demo/demo-transcript.txt)               |

> 发布后回填：发布渠道与链接、首个陌生人回报（看板 §212）。
