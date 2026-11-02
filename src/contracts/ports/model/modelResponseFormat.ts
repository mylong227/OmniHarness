/**
 * 结构化输出的**请求侧契约**（2026-10-11，目标项「结构化输出（JSON Schema）」）。
 *
 * ## 为什么要有它
 *
 * 此前 `ModelRequest` 只有 messages/tools/reasoningEffort/temperature/signal —— **完全没有**
 * 结构化输出的位置 ⇒ 五条通路（openai 兼容 / responses / anthropic / llama.cpp(Ollama) / mock）
 * 一律**零支持**，而"让模型吐 JSON"只能靠提示词里写"请只输出 JSON"，再由调用方 `JSON.parse` 撞运气。
 * 这不是能力缺失的登记问题，是**契约缺字段**。
 *
 * ## 三家上游的形态差异（本契约必须能表达，且适配器各自落到正确位置）
 *
 * | 上游 | 落点 |
 * | --- | --- |
 * | OpenAI Chat Completions 兼容 | `response_format: {type:'json_schema', json_schema:{name, schema, strict}}` / `{type:'json_object'}` |
 * | OpenAI Responses API | `text: {format: {type:'json_schema', name, schema, strict}}` / `{type:'json_object'}` |
 * | Anthropic Messages | **无原生字段** ⇒ 用「单工具强制」等价实现：注入一个 input_schema=schema 的工具 + `tool_choice:{type:'tool',name}` |
 * | Ollama（llama.cpp 通路） | `format: <schema>`（Ollama ≥0.5）/ `format: 'json'` |
 *
 * 故契约只描述**意图**（要不要 JSON、有没有 schema、要不要严格模式），落点由各适配器决定 ——
 * 这正是六边形架构该有的分工。
 */

/** 文本输出（默认；等价于不声明 `responseFormat`）。 */
export interface TextResponseFormat {
  readonly kind: 'text';
}

/** 只要"合法 JSON"、不限形状（上游的 `json_object` 档）。 */
export interface JsonObjectResponseFormat {
  readonly kind: 'json-object';
}

/**
 * 指定 JSON Schema（上游的 `json_schema` 档）。
 *
 * `name` 是 OpenAI 侧**必填**的格式名（`^[a-zA-Z0-9_-]{1,64}$`）；Anthropic 侧用它作强制工具名；
 * Ollama 侧忽略。故本字段在设计上是"必须给"而不是"可选"——避免某条通路到了发送时才发现缺名。
 */
export interface JsonSchemaResponseFormat {
  readonly kind: 'json-schema';
  /** 格式名（同上；各适配器须保证它满足上游的命名约束）。 */
  readonly name: string;
  /** JSON Schema（对象形态；本仓不引入 schema 校验库，故原样透传）。 */
  readonly schema: Readonly<Record<string, unknown>>;
  /** 严格模式（仅 OpenAI 系定义；缺省不发该字段，尊重端点默认）。 */
  readonly strict?: boolean | undefined;
}

/** 结构化输出的请求侧意图。 */
export type ModelResponseFormat =
  TextResponseFormat | JsonObjectResponseFormat | JsonSchemaResponseFormat;
