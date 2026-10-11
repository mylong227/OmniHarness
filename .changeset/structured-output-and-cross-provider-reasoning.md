---
'@mylong227/omniharness': minor
---

目标第 (6) 项「新能力」三项全部落地：**结构化输出（JSON Schema）**、**跨 provider reasoning 档**、
**缓存命中率分因**（第三项见上一个 changeset）。三处都先补**契约缺字段**，再逐通路接线，并附正对照判据。

## ① 结构化输出（JSON Schema）：从"契约里没有这个字段"到五通路落地

修之前：`ModelRequest` **根本没有**结构化输出的位置 ⇒ 五条通路（OpenAI 兼容 / Responses /
Anthropic / Ollama / mock）一律零支持，"让模型吐 JSON"只能靠提示词写"请只输出 JSON"再 `JSON.parse` 撞运气。

- **端口**：新增 `ports/model/modelResponseFormat.ts`（`text` / `json-object` / `json-schema{name,schema,strict?}`），
  并在 `ModelRequest` 上加 `responseFormat?`（缺省＝纯文本，与旧行为逐字一致）。
- **映射收在一处**：`adapters/model/modelResponseFormats.ts` 负责落到四家各自的字段 ——
  Chat `response_format`、Responses `text.format`、Anthropic **等价实现（单工具强制）**、Ollama `format`。
  不合规的 OpenAI 格式名在**构造请求体**时即抛（fail-closed：不留给端点 400 把"配置写错"伪装成"上游故障"）。
- **Anthropic 的等价实现要闭环**：注入强制工具后，响应里的那条 `tool_use` 必须**转回 JSON 文本**并
  **从 `toolCalls` 剔除** —— 否则 harness 会去执行一个不存在的"工具"，而调用方永远拿不到结构化文本。
- **mock 也支持**：按 schema 的 `required` 造出类型相符的占位值 ⇒ 该能力在**无 API Key** 环境下
  可端到端验证（`--mock` 的存在理由正是"零额度试跑"）；非结构化时仍走原脚本（正对照）。

## ② 跨 provider reasoning 档：三条通路此前**完全忽略**该意图

修之前：`reasoningEffort` 只在 OpenAI 兼容通路透传成 `reasoning_effort`；Responses / Anthropic /
Ollama **完全忽略** ⇒ 用户设了档位在那三家上等于什么都没发生（静默失效）。

- 新增 `adapters/model/modelReasoningEfforts.ts` 单一映射：Chat `reasoning_effort`（原语义保留）、
  Responses `reasoning:{effort}`、Anthropic `thinking:{type:'enabled',budget_tokens}`、Ollama `think`。
- **两条硬约束**：① Anthropic 要求 `max_tokens > budget_tokens`，故同时抬高 `max_tokens`（配置值更大时保留配置值）；
  ② 未登记档位在 Anthropic 侧 **fail-closed**（Anthropic 必须换算成具体预算，猜数字等于把"要高强度推理"静默降级）。
- **修完当场发现并补上一个自己引入的集成缺陷**：配置枚举有 **7 档**
  （`none|minimal|low|medium|high|xhigh|max`，见 `configError` 的 `ENUM_VALUES`），初版映射只覆盖 4 档 ⇒
  用户设合法的 `xhigh` 会让 Anthropic 通路抛错。现补全 6 档预算（`none` = 不下发 thinking），
  并加判据 **③-b**：**从 `configError.ts` 逐字读出枚举**，要求映射表覆盖其全部档位（附正对照）。

## 判据

- `tests/unit/structuredOutput.test.ts`（9 例）：三态线体形状、旧行为不变（纯文本/缺省**不发**该字段）、
  Anthropic 强制工具的请求侧与响应侧闭环、**真工具不被误伤**的正对照、Ollama 三态、mock 结构化与非结构化、
  格式名 fail-closed、**单一实现**（上游字段字面量只许住在映射模块）。
- `tests/unit/crossProviderReasoning.test.ts`（7 例）：四通路落点、Anthropic 的 `max_tokens > budget` 不变量、
  `none` 档不下发、预算序列严格递增、未知档位抛错 + 正对照、枚举覆盖对账、单一实现。

## 验证

- 受影响的既有模型判据（10 文件 74 例）**全绿**，无回归。
- 门禁 10 项 + 类型层 + 编码标准增量 **全绿**；覆盖率门禁见本次 `coverage:check` 结果。
