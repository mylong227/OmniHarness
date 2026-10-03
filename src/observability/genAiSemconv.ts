/**
 * **GenAI 语义约定（semconv）键名与版本锚**（G23，2026-10-03 第十一轮）。
 *
 * ## 为什么是"加字段、不改名"
 *
 * OpenTelemetry 的 GenAI 约定（`docs/gen-ai/*`）截至 **v1.44.0** 全部处于 **Development**：
 * spans / metrics / token-metrics / events / exceptions / mcp / openai / anthropic 九份文档的 Status
 * 全是 Development，`gen_ai.operation.name` 的 19 个 well-known 取值亦然。**按 Development 面硬改名是单向门**
 * ——上游一改，我们的历史 trace 与查询面板同时失效。故本仓**并行**发标准键，**保留**既有 `tool.*` /
 * `tokens.*` / `session.*` 键作为过渡（消费方可任选一套）。
 *
 * ## 口径声明（本文件是唯一事实来源）
 *
 * 1. 只发**我们有把握是标准键**的那几个（见 {@link GEN_AI_KEYS}）；对仍在演进、或本仓无法确证名字的
 *    语义（例如会话/对话标识、缓存读 token 的 spans 侧键名）**刻意不发**——发一个"看起来标准但其实是
 *    自造"的键，比不发更糟（消费方会当真）。
 * 2. `cache_read` 是 `input_tokens` 的**子集**（semconv token-metrics 脚注明确）：本仓的
 *    `gen_ai.usage.input_tokens` 发的是**含缓存读**的输入总量，绝不与缓存读相加
 *    （本仓 `tokenAttribution.ts` 的同类口径是对的，这里保持一致）。
 * 3. {@link SEMCONV_VERSION} 是**版本锚**：升级它必须同时复核键名并更新
 *    `tests/unit/genAiSemconvConformance.test.ts` 里钉住的键集——那一步会红，正是要人复核。
 *
 * ## 为什么"上游一变即红"是这么实现的
 *
 * 离线环境（本仓门禁不联网）**无法**实时校验上游。可执行的做法是把"我们依据的版本 + 我们发的键集 +
 * 我们保留的旧键集"三者一起钉进测试：任何一方变动都要显式改测试 ⇒ 强制复核。测试文件头写明了这一点，
 * 不把它伪装成"实时一致性校验"。
 */

/**
 * 本仓对齐所依据的 semconv 版本（**版本锚**）。
 *
 * 来源：报告 §3.7 的调研（GenAI 约定全线 Development，最新版本 v1.44.0）。升级此常量务必同时复核
 * {@link GEN_AI_KEYS} 与一致性测试里钉住的键集。
 */
export const SEMCONV_VERSION = '1.44.0';

/**
 * 本仓发出的 **GenAI 标准键**（spans 侧）。
 *
 * 值即键名本身，避免调用点散落字符串字面量（改一处即全改，且便于一致性测试直接枚举）。
 */
export const GEN_AI_KEYS = {
  /** 操作名（本仓用 `chat` 表示推理、`execute_tool` 表示工具执行——两者都是 well-known 取值）。 */
  operationName: 'gen_ai.operation.name',
  /** 工具名（工具执行 span）。 */
  toolName: 'gen_ai.tool.name',
  /** 请求模型名。 */
  requestModel: 'gen_ai.request.model',
  /** 响应模型名（本仓与请求同名：事件里只有一个 `model` 字段，不臆造第二个值）。 */
  responseModel: 'gen_ai.response.model',
  /** 输入 token（**含**缓存读——`cache_read` 是它的子集，不得相加）。 */
  usageInputTokens: 'gen_ai.usage.input_tokens',
  /** 输出 token。 */
  usageOutputTokens: 'gen_ai.usage.output_tokens',
} as const;

/**
 * 本仓**沿用**的过渡键（语义与上面一一对应；等 semconv 转 Stable 后再谈改名）。
 *
 * 单独列出来是为了让一致性测试能**同时**断言"新键在"与"旧键没被删"——后者才是"不改名"的保证。
 */
export const LEGACY_KEYS = {
  /** 会话标识（semconv 的对话/会话键仍在演进，故本期沿用本仓键）。 */
  sessionId: 'session.id',
  /** 工具名（legacy）。 */
  toolName: 'tool.name',
  /** 工具是否成功（legacy）。 */
  toolOk: 'tool.ok',
  /** 模型名（legacy）。 */
  modelName: 'model.name',
  /** 输入 token（legacy）。 */
  tokensPrompt: 'tokens.prompt',
  /** 输出 token（legacy）。 */
  tokensCompletion: 'tokens.completion',
  /** 总 token（legacy；semconv 无"总量"键，故只保留本仓键）。 */
  tokensTotal: 'tokens.total',
  /** 会话内工具调用次数（legacy，仅汇总 span 有）。 */
  sessionToolCalls: 'session.tool_calls',
  /** 会话内模型调用次数（legacy，仅汇总 span 有）。 */
  sessionModelCalls: 'session.model_calls',
  /** 会话内 token 总量（legacy，仅汇总 span 有）。 */
  sessionTokens: 'session.tokens',
} as const;

/** GenAI 的 well-known 操作名（本仓只用到这两个）。 */
export const GEN_AI_OPERATIONS = {
  /** 推理（chat completions 类调用）。 */
  chat: 'chat',
  /** 工具执行。 */
  executeTool: 'execute_tool',
} as const;
