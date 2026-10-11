import type { ModelResponseFormat } from '../../ports/model/modelResponseFormat.js';

/**
 * 结构化输出的**上游线体映射**（单一实现，2026-10-11）。
 *
 * 为什么集中在这里：五条通路（OpenAI Chat / OpenAI Responses / Anthropic / Ollama / mock）
 * 要把同一份"意图"落到四个**互不相同**的字段上。若各适配器各写一遍，任何一条上游改字段名
 * 都只会改到其中一两条——本仓对这类"同一规则多处实现"的老毛病（见 `pendingRequests` 的收口）
 * 已经吃过亏，故一开始就收成一处，并由 `tests/unit/structuredOutput.test.ts` 逐通路断言。
 */

/** OpenAI 结构化输出的格式名约束（服务端强制；不合规的会在端点 400）。 */
const OPENAI_FORMAT_NAME = /^[a-zA-Z0-9_-]{1,64}$/u;

/** 各通路共用的请求体片段（`undefined` = 该通路不该带任何字段）。 */
export class ModelResponseFormats {
  /**
   * OpenAI Chat Completions 的 `response_format`。
   *
   * @param format 请求侧意图（缺省＝纯文本）。
   * @returns 线体片段；纯文本 / 缺省时为 `undefined`。
   * @throws Error 当 schema 档的 `name` 不满足 OpenAI 的命名约束（**fail-closed**：与其让端点在
   *   发送后 400、把"配置写错"伪装成"上游故障"，不如在构造请求体时就说清）。
   */
  public static toOpenAiChat(format?: ModelResponseFormat): Record<string, unknown> | undefined {
    if (format === undefined || format.kind === 'text') return undefined;
    if (format.kind === 'json-object') return { type: 'json_object' };
    ModelResponseFormats.assertOpenAiName(format.name);
    return {
      type: 'json_schema',
      json_schema: {
        name: format.name,
        schema: format.schema,
        // 严格模式仅在显式声明时发送：缺省不发，尊重端点默认（部分兼容端点不认识该字段）。
        ...(format.strict === true ? { strict: true } : {}),
      },
    };
  }

  /**
   * OpenAI Responses API 的 `text.format`。
   *
   * @param format 请求侧意图。
   * @returns 线体片段；纯文本 / 缺省时为 `undefined`。
   */
  public static toResponsesText(format?: ModelResponseFormat): Record<string, unknown> | undefined {
    if (format === undefined || format.kind === 'text') return undefined;
    if (format.kind === 'json-object') return { format: { type: 'json_object' } };
    ModelResponseFormats.assertOpenAiName(format.name);
    return {
      format: {
        type: 'json_schema',
        name: format.name,
        schema: format.schema,
        ...(format.strict === true ? { strict: true } : {}),
      },
    };
  }

  /**
   * Anthropic 的**等价实现**：单工具强制。
   *
   * Anthropic Messages 没有 `response_format` 一类字段，官方推荐做法就是"声明一个工具 +
   * `tool_choice` 指定它"，模型于是只能以该工具的 `input` 形状作答。适配器随后要把这条
   * `tool_use` 的 `input` 转回**文本内容**（`JSON.stringify`），否则调用方拿到的是工具调用、
   * 与"结构化文本输出"的契约不符。
   * @param format 请求侧意图。
   * @returns `{tool, toolChoice}`；纯文本 / 缺省时为 `undefined`。
   */
  public static toAnthropicForcedTool(
    format?: ModelResponseFormat,
  ):
    | { readonly tool: Record<string, unknown>; readonly toolChoice: Record<string, unknown> }
    | undefined {
    if (format === undefined || format.kind === 'text') return undefined;
    const name = format.kind === 'json-schema' ? format.name : 'structured_output';
    const schema = format.kind === 'json-schema' ? format.schema : ({ type: 'object' } as const);
    return {
      tool: {
        name,
        description: '以 JSON 对象作答（结构化输出；由 Harness 注入并强制选择）',
        input_schema: schema,
      },
      toolChoice: { type: 'tool', name },
    };
  }

  /**
   * Ollama（llama.cpp 通路）的 `format` 字段。
   *
   * Ollama ≥0.5 接受**完整 JSON Schema**（`format: {…}`）或字符串 `'json'`；
   * 本仓取这两档（不再退回 GBNF 语法——那是另一条实现面，没有真实样本不推断）。
   * @param format 请求侧意图。
   * @returns `format` 字段值；纯文本 / 缺省时为 `undefined`。
   */
  public static toOllamaFormat(format?: ModelResponseFormat): unknown {
    if (format === undefined || format.kind === 'text') return undefined;
    if (format.kind === 'json-object') return 'json';
    return format.schema;
  }

  /**
   * 校验 OpenAI 的格式名约束。
   *
   * @param name 格式名。
   * @returns 无返回值；不合规即抛。
   */
  private static assertOpenAiName(name: string): void {
    if (!OPENAI_FORMAT_NAME.test(name)) {
      throw new Error(
        `结构化输出的 name 不合规: ${JSON.stringify(name)}（OpenAI 要求 ^[a-zA-Z0-9_-]{1,64}$）`,
      );
    }
  }
}
