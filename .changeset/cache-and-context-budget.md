---
'omniharness': minor
---

提示缓存真正接入（含真机命中率数字）**+** 上下文预算不再 fail-open。

**缓存（Anthropic + 可观测 + 真机证据）**

- **Anthropic 滚动缓存断点**：新增 `AnthropicCacheBreakpoints`（纯函数），名额 `4−(有 system?1:0)`，从**已完成轮次**取最近若干条 user 消息打断点（**不打在最新消息上**——字节前缀缓存对「本轮才成形的内容」无可复用字节；改写历史消息的字节反而会葬送已缓存前缀）。OpenAI/DeepSeek 为自动前缀缓存，未加字段，也未在消息头部插入动态内容。
- **命中率语义与加固**：`cacheStat` 原先原样累加 `promptTokens`，一条脏事件即可让整会话命中率变 `NaN` 或 `>100%`；现整条忽略非法 payload（非对象/非有限数/负数/缺分母）并把 cached 钳制到 prompt。新增 30 例单测覆盖 measured/estimated/empty 三态、除零、钳制、**按 token 加权**、舍入口径。
- **坍塌可执行化**：新增 `CacheHitRateWatch`（只告警不阻断）——会话 ≥5 次模型调用且命中率低于阈值时产出 `model.cache.lowHitRate`（warn，带四个数字）。阈值 env `OMNI_CACHE_HIT_WARN`，默认 50%（依据：各模型缓存价≈原价 1/3，p=50% 时成本≈原价 67%）。
- **真机证据**：新增 `evals/cache-probe.mjs`（同前缀两轮，命中量用生产同一份读者读取；第 2 轮零命中即 exit 非 0）。实测 DeepSeek `deepseek-chat`：第 2 轮 `946 prompt / 768 cached = 81.2%`（第 1 轮 81.7% 系与先前探针前缀重叠的"预热"，不作为稳态数字）。
- **未真机验证**：Anthropic 断点收益仅有「请求体结构 + 上限 + 前缀稳定性」单测级证明（本机无 Anthropic 凭据）；探针目前只走 OpenAI 协议。

**上下文压缩不再 fail-open**

- 缺陷：`keepRecent ≥ 消息总数`（无 head 可折叠）时，`ContextCompactor` **原样返回消息却报 `compacted: true` + `summary: '[历史已省略]'`**，类里根本没有截断调用。实测：阈值 100、输入 4 万字符 → **输出仍 4 万字符**、`out === in` ⇒ 假称已压缩、超窗请求照发（下一步直接撞端点上限）。
- 修法：该分支改为按真实预算**从最旧一端逐条丢弃**（每次丢弃后重新 `sanitizeToolRounds`，避免留下 orphan tool 被上游 400），并把丢弃条数如实写进摘要；本就在预算内则如实回 `compacted: false`（不谎报）。主路径同时补兜底：摘要 + 最近消息仍超预算时丢弃较旧的 tail 消息（保留摘要与最新一条）。
- **契约变更**：三个既有断言原先钉住了 fail-open（如 `{maxTokens:1, keepRecent:10}` 保留全部 3 条），已改为新不变量——「超预算必须真丢弃且如实报告」+「未超预算不得谎报已压缩」。

**行为变更提示**：① Anthropic 请求体消息侧新增 ≤3 个 `cache_control` 断点；② 新增 env `OMNI_CACHE_HIT_WARN` 与观测事件 `model.cache.lowHitRate`；③ 压缩结果在超预算时会真的丢弃最旧消息（此前会假称已压缩）。
