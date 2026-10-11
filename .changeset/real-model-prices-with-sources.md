---
'@mylong227/omniharness': minor
---

成本定价：把 8 个出货默认族里**查得到公开价目**的都填入真实单价，并把来源做成**可复核登记**。

## 之前是什么状态

`DEFAULT_ROUTE_PRICING` 里有 8 个出货默认族**只有"不定价登记"、没有价目**
（`UNPRICED_DEFAULT_FAMILIES`），于是它们静默按 `DEFAULT_FALLBACK_PRICE`（1.0/3.0）估算——
对高端档偏低（熔断过晚）、对廉价档偏高（熔断过早），登记表只让它"如实自报"，不修正数字。

## 现在填了什么（单价 USD / 百万 token，输入 / 输出 / 缓存读）

| 族                     | 键                                  | 单价                                                      |
| ---------------------- | ----------------------------------- | --------------------------------------------------------- |
| DeepSeek v4            | `deepseek-v4-flash`、`-vision-exp`  | 0.30 / 1.20 / 0.006                                       |
|                        | `deepseek-v4-pro`                   | 1.32 / 3.96 / 0.044                                       |
| Moonshot v1            | `moonshot-v1-8k` / `-32k` / `-128k` | 0.20 / 2.00、1.00 / 3.00、2.00 / 5.00                     |
| 智谱 GLM               | `glm-4.5` / `-air` / `-flash`       | 0.60 / 2.20、0.20 / 1.10、0 / 0                           |
| 通义千问（云端明确档） | `qwen-max` / `-plus` / `-turbo`     | 1.60 / 6.40、0.40 / 1.20、0.05 / 0.20                     |
| Google Gemini 2.5      | `pro` / `flash` / `flash-lite`      | 1.25 / 10 / 0.125、0.30 / 2.50 / 0.03、0.10 / 0.40 / 0.01 |
| Anthropic              | `claude-3-5-haiku`                  | 0.80 / 4.00 / 0.08                                        |
| OpenAI                 | `gpt-4.1`                           | 2.00 / 8.00 / 0.50                                        |

**仍不给数字的 4 个键**（理由改为"实际查过什么"）：`kimi-k2`（出货名 `kimi-k2-turbo-preview` /
`-0905-preview` 在价目库里不存在，只有 k2.5+/转售档）、`glm-4-plus`（库里只有 4.5/4.6/4.7）、
`qwen3-coder-plus`（有条目但无成本字段）、裸前缀 `qwen`（可能跑本地 ollama ⇒ 边际成本≈0，
不按 0 计；明确档位已单独定价）。

## 来源（可复核，不是"来自某网站"）

新增 `PRICE_SOURCES`：固定到 **git blob SHA** 的引用——同一个 SHA 内容逐字节不变，任何人可复算。
本轮用的是公开聚合价目库 LiteLLM `model_prices_and_context_window.json`
（`.../git/blobs/780adab42ab7e028f2e04faf8b68b67af4dc3813`），逐条取**厂商直连条目**
（`litellm_provider` = deepseek / moonshot / zai / dashscope / gemini / openai）。

**诚实登记**：本机厂商官方定价页**不可达**（`platform.openai.com/docs/pricing` → HTTP 403 Cloudflare、
`ai.google.dev/gemini-api/docs/pricing` → fetch failed、`raw.githubusercontent.com` 直取亦失败），
故不是"权威来源"而是"可复核来源"；唯一例外已注明：3.5 Haiku 在库里**没有 anthropic 直连条目**，
取的是同型号 id 的 bedrock 档（0.8/4.0，与厂商公开价一致但来源是转售档）。官方页可达时应替换。

## 影响

- 这些族的成本估算不再落兜底价 ⇒ 硬预算熔断时机更准；`BudgetSnapshot.unpricedModels`
  也随之只报真正无价目的模型（判据⑤/⑥ 的样本已换成仍无来源的 `kimi-k2-turbo-preview`）。
- 判据：`routePriceSources.test.ts` 5 例（来源固定到 SHA、note 说明取哪条、17 个键**精确命中**、
  登记理由须点明查过什么、正对照）+ `routePricingDefaults.test.ts` 6 例（含"有价目或有不定价登记"）。
