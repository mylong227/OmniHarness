---
'@mylong227/omniharness': patch
---

OTLP 属性与 **GenAI semconv 对齐（加字段、不改名）**（G23，O2）。

## 背景（报告 §3.7）

OpenTelemetry 的 GenAI 约定截至 **v1.44.0** 全部处于 **Development**（九份文档 Status 全是 Development，
`gen_ai.operation.name` 的 19 个 well-known 取值亦然）⇒ **按它硬改名是单向门**：上游一改，历史 trace
与查询面板同时失效。故本项**并行**发标准键、**保留**既有键作过渡。

本仓 trace 此前与 semconv 全面不符：属性无 `gen_ai.` 前缀，且把数值塞进 `stringValue`（OTLP 有
`intValue`/`doubleValue`）⇒ 任何标准 GenAI 后端**无法按类型分派**，token/计数一律读不出来。

## 改动

1. 新增 `src/observability/genAiSemconv.ts`（唯一事实来源）：`SEMCONV_VERSION='1.44.0'` 版本锚 +
   `GEN_AI_KEYS`（标准键）+ `LEGACY_KEYS`（过渡键）+ `GEN_AI_OPERATIONS`。文件头写清三条口径：
   ① 只发有把握是标准的键，**对仍在演进或无法确证的语义（会话/对话标识、缓存读的 spans 侧键名）
   刻意不发**——发一个"看起来标准其实是自造"的键比不发更糟；② `cache_read` 是 `input_tokens` 的
   子集，**绝不相加**；③ 升级版本锚必须同时复核键名（一致性测试会红）。
2. `otlpTraceExporter.ts`：属性值类型扩宽为 `OtlpAttributeValue`（`stringValue`/`intValue`/`doubleValue`），
   `intValue` 用 **proto3 JSON 的 int64 字符串形态**（加法式改动，既有生产者零改动）。
3. `traceSpanBuilder.ts`：**数值属性改走 `intValue`**（不再 `stringValue`）；工具/模型 span **并行**
   发标准键：
   - 工具：`gen_ai.tool.name`、`gen_ai.operation.name='execute_tool'`；
   - 模型：`gen_ai.operation.name='chat'`、`gen_ai.request.model`、`gen_ai.response.model`、
     `gen_ai.usage.input_tokens`（**含**缓存读的总量）、`gen_ai.usage.output_tokens`；
   - 过渡键 `tool.*` / `tokens.*` / `session.*` **一个不少**（"不改名"的保证）。
     汇总 span 只保留本仓键（会话键仍在演进，不硬凑）。

## 判据（`tests/unit/genAiSemconvConformance.test.ts`，5 例，离线零 key）

① 版本锚固定为已复核版本（升级即红，逼人复核键名）；② 工具 span：标准键在 + **过渡键用字面键名逐个断言仍在**；
③ 模型 span：标准用量键 + 过渡键并存，且不臆造第二个模型名；④ 数值属性必须走 `intValue`
（整数字符串形态）且不得再用 `stringValue`；⑤ 缓存读口径：`input_tokens=100`（含其中 40 命中缓存），
**不是 140**。

**变异测试**：把过渡键 `tool.name` 改名 ⇒ ② **变红**。⚠️ 值得记的是：本用例**首版抓不到这个变异**
——它断言的是常量（`LEGACY_KEYS.toolName`），builder 与常量一起改名时恒等成立 ⇒ 判据永远绿。
改为**字面键名**断言后变异才真正变红。这条已写进用例注释。

**口径变更的连带修正**：既有 `otlpTraceWiring.test.ts` 有两处断言数值属性的 `stringValue`
（钉的是旧的非规范编码），已改为 `intValue` 并注明原因；`traceSpanBuilder` / `otlpTraceExporter` /
`otlpTraceWiring` / `traceWiring` / `traceCliWiring` 共 19 例全过。

## 口径边界（如实登记）

一致性测试钉住的是**我们声明的对齐目标**（版本 + 标准键 + 过渡键三者一起），**不是**"上游此刻是否仍这样写"
——门禁不联网，做不到实时校验；故采用"版本一动就红"的方式强制复核，不把它伪装成实时一致性校验。
未发 `gen_ai.*` 的会话/对话键与缓存读 spans 侧键，理由见上（宁缺勿造）。
