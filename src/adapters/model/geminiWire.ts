import { ModelCallError } from '../../ports/model/model.ts';
import type {
  ModelResponseFormat,
  ModelToolCallRef,
  ModelToolSpec,
  ModelUsage,
} from '../../ports/model/model.ts';
import { ModelFinishReasons } from '../../util/modelFinishReasons.ts';
import { log } from '../../util/logger.ts';
import { ModelHttpErrors } from './modelHttpErrors.ts';
import { ToolArgumentParser, type ParsedToolArguments } from './toolArgumentParser.ts';
import type {
  GeminiErrorPayload,
  GeminiFunctionCall,
  GeminiInlineData,
  GeminiUsageMetadata,
} from './geminiTypes.ts';

/** 推理档位 → Gemini `thinkingConfig.thinkingBudget`（与 Anthropic 同组单调递增预算）。 */
const THINKING_BUDGETS: Readonly<Record<string, number>> = {
  none: 0,
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16_384,
  xhigh: 24_576,
  max: 32_768,
};

/** Gemini 允许的思考预算区间（超出即 clamp）。 */
const MIN_THINKING_BUDGET = 0;
const MAX_THINKING_BUDGET = 32_768;

/** Gemini 安全类结束原因（统一映射为 `content_filter`）。 */
const FILTER_FINISH_REASONS: ReadonlySet<string> = new Set([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'IMAGE_SAFETY',
]);

/**
 * Gemini 原生协议的**线体映射**（纯函数集中处，无状态可并发复用）。
 *
 * 与 `GeminiModel` 拆开：请求/响应编排的类成员数必须留在仓库「上帝类」阈值内；
 * reasoning 档位、用量、结束原因这些映射与网络/生命周期无关，独立成类更好审阅。
 */
export class GeminiWire {
  /**
   * 推理档位 → `thinkingConfig`。
   * @param effort 推理档位（未设/空串 = 不发该字段）。
   * @param maxBudget 该模型允许的最大思考预算（缺省用全局上限；Pro 与 Flash 不同）。
   * @returns `{thinkingBudget}`；未设时为 undefined。
   * @throws Error 档位未登记（fail-closed，绝不猜一个数字）。
   */
  public static thinkingConfigOf(
    effort?: string,
    maxBudget: number = MAX_THINKING_BUDGET,
  ): Record<string, number> | undefined {
    if (typeof effort !== 'string' || effort === '') {
      return undefined;
    }
    const budget = THINKING_BUDGETS[effort];
    if (budget === undefined) {
      throw new Error(
        `Gemini 无法把 reasoningEffort=${JSON.stringify(effort)} 映射成 thinkingBudget；` +
          `可接受取值：${Object.keys(THINKING_BUDGETS).join(' | ')}` +
          '（必须换算成具体 token 预算，猜一个数字等于静默降级）',
      );
    }
    const cap = Math.min(MAX_THINKING_BUDGET, maxBudget);
    return {
      thinkingBudget: Math.min(cap, Math.max(MIN_THINKING_BUDGET, budget)),
    };
  }

  /**
   * 按模型取官方允许的最大思考预算。
   *
   * 依据 Gemini 文档：2.5 Pro 允许 `128–32768`，2.5 Flash / Flash-Lite 允许 `0–24576`。
   * 对未识别的模型取更保守的 24576，避免把 Flash 不接受的值发出去（Pro 仍可显式获得 32768）。
   * @param model 模型标识（可含 `models/` 前缀）。
   * @returns 最大思考预算。
   */
  public static thinkingBudgetCapFor(model: string): number {
    return /(?:^|[/-])pro(?:$|[-/])/iu.test(model) ? MAX_THINKING_BUDGET : 24_576;
  }

  /**
   * 结构化输出意图 → generationConfig 片段。
   * @param format 请求侧意图。
   * @returns `responseMimeType` / `responseJsonSchema`；纯文本或未设时为 undefined。
   */
  public static responseFormatOf(
    format?: ModelResponseFormat,
  ): Record<string, unknown> | undefined {
    if (format === undefined || format.kind === 'text') {
      return undefined;
    }
    if (format.kind === 'json-object') {
      return { responseMimeType: 'application/json' };
    }
    return {
      responseMimeType: 'application/json',
      responseJsonSchema: format.schema,
    };
  }

  /**
   * 工具规格 → `functionDeclarations`。
   * @param tools 统一工具规格列表。
   * @returns Gemini 函数声明数组（parameters 非对象时回退为空 object schema）。
   */
  public static functionDeclarations(tools: readonly ModelToolSpec[]): unknown[] {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters:
        typeof tool.parameters === 'object' &&
        tool.parameters !== null &&
        !Array.isArray(tool.parameters)
          ? tool.parameters
          : { type: 'object', properties: {} },
    }));
  }

  /**
   * 解析单个 `functionCall`。
   * @param call wire 层函数调用。
   * @param counts 同名调用计数器（就地更新；用于在缺 id 时合成唯一 id）。
   * @returns 统一工具调用；缺函数名时返回 undefined。
   */
  public static toolCallOf(
    call: GeminiFunctionCall,
    counts: Map<string, number>,
  ): ModelToolCallRef | undefined {
    const name = typeof call.name === 'string' ? call.name.trim() : '';
    if (name === '') {
      return undefined;
    }
    const seen = counts.get(name) ?? 0;
    counts.set(name, seen + 1);
    const explicitId = typeof call.id === 'string' ? call.id.trim() : '';
    const id = explicitId !== '' ? explicitId : seen === 0 ? name : `${name}#${String(seen + 1)}`;
    const parsed = GeminiWire.argumentsOfDetailed(call.args);
    return {
      id,
      name,
      arguments: parsed.arguments,
      ...(parsed.error !== undefined ? { parseError: parsed.error } : {}),
      ...(typeof call.thoughtSignature === 'string' && call.thoughtSignature !== ''
        ? { thoughtSignature: call.thoughtSignature }
        : {}),
    };
  }

  /**
   * 工具参数窄化（字符串走共享 `ToolArgumentParser`；非法形态回退空对象并留痕）。
   * @param raw wire 层参数（对象 / JSON 字符串 / 缺失）。
   * @returns 参数对象；非法时为空对象（与 ToolArgumentParser 的 fail-closed 语义一致）。
   */
  public static argumentsOf(raw: unknown): Record<string, unknown> {
    return GeminiWire.argumentsOfDetailed(raw).arguments;
  }

  /**
   * 工具参数窄化（带诊断）：字符串 JSON 不可修复时把 `error` 交给调用方 fail-closed。
   * @param raw wire 层参数（对象 / JSON 字符串 / 缺失）。
   * @returns 参数对象与可选错误说明。
   */
  public static argumentsOfDetailed(raw: unknown): ParsedToolArguments {
    if (raw === undefined || raw === null) {
      return { arguments: {} };
    }
    if (typeof raw === 'string') {
      return ToolArgumentParser.parseDetailed(raw);
    }
    if (typeof raw === 'object' && !Array.isArray(raw)) {
      return { arguments: raw as Record<string, unknown> };
    }
    log.warn('model.gemini.tool_arguments.invalid', {
      kind: Array.isArray(raw) ? 'array' : typeof raw,
    });
    return {
      arguments: {},
      error: `Gemini 工具参数不是对象（实际 ${Array.isArray(raw) ? 'array' : typeof raw}）`,
    };
  }

  /**
   * 合成统一用量。
   * @param raw `usageMetadata`。
   * @returns 统一用量；一个计数字段都没有时为 undefined（不臆造 0）。
   */
  public static usageOf(raw?: GeminiUsageMetadata): ModelUsage | undefined {
    if (raw === undefined) {
      return undefined;
    }
    const count = (value: number | undefined): number | undefined =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? Math.round(value)
        : undefined;
    const prompt = count(raw.promptTokenCount);
    const candidates = count(raw.candidatesTokenCount);
    const thoughts = count(raw.thoughtsTokenCount);
    const total = count(raw.totalTokenCount);
    if (
      prompt === undefined &&
      candidates === undefined &&
      thoughts === undefined &&
      total === undefined
    ) {
      return undefined;
    }
    const promptTokens = prompt ?? 0;
    // Gemini 的 totalTokenCount 含思考 token；优先用它反推输出量，保持 total = prompt + completion。
    const completionTokens =
      candidates !== undefined || thoughts !== undefined
        ? (candidates ?? 0) + (thoughts ?? 0)
        : Math.max(0, (total ?? 0) - promptTokens);
    const totalTokens = total ?? promptTokens + completionTokens;
    const cached = count(raw.cachedContentTokenCount);
    const usage: ModelUsage = { promptTokens, completionTokens, totalTokens };
    return cached === undefined ? usage : { ...usage, cachedPromptTokens: cached };
  }

  /**
   * 归一化结束原因（`MAX_TOKENS` → `length`；安全拦截 → `content_filter`）。
   * @param raw Gemini wire 值。
   * @returns 统一结束原因；缺失时 undefined。
   */
  public static finishReasonOf(raw?: string | null): string | undefined {
    if (typeof raw !== 'string' || raw === '') {
      return undefined;
    }
    if (FILTER_FINISH_REASONS.has(raw.trim().toUpperCase())) {
      return 'content_filter';
    }
    return ModelFinishReasons.normalize(raw) ?? raw;
  }

  /**
   * 从「URL 或 base64」提取 Gemini inlineData。
   * @param url 可选 data URI / http(s) URL。
   * @param data 可选裸 base64 或 data URI。
   * @param mediaType 可选 MIME 类型（裸 base64 时使用）。
   * @returns inlineData；非内联形态返回 undefined。
   */
  public static inlineDataOf(
    url: string | undefined,
    data: string | undefined,
    mediaType: string | undefined,
  ): GeminiInlineData | undefined {
    const inline = (data ?? '').trim();
    const raw = inline !== '' ? inline : (url ?? '').trim();
    if (raw === '') {
      return undefined;
    }
    if (!raw.startsWith('data:')) {
      // 裸 base64 只在来自 `data` 字段时可判定；http(s)/file:// 不是内联载荷。
      return inline === ''
        ? undefined
        : {
            mimeType: mediaType ?? 'application/octet-stream',
            data: inline,
          };
    }
    const comma = raw.indexOf(',');
    if (comma < 0) {
      return undefined;
    }
    const header = raw.slice(5, comma);
    if (!header.endsWith(';base64')) {
      return undefined;
    }
    const mimeType = header.slice(0, -7) || mediaType || 'application/octet-stream';
    const payload = raw.slice(comma + 1);
    return payload === '' ? undefined : { mimeType, data: payload };
  }

  /**
   * 把流中错误负载转为结构化错误（数字 code 按 HTTP 语义分类，否则委托共享映射器）。
   * @param error Gemini 错误对象。
   * @returns 结构化模型调用错误。
   */
  public static streamErrorOf(error: GeminiErrorPayload): ModelCallError {
    const message = typeof error.message === 'string' ? error.message : '';
    if (typeof error.code === 'number' && Number.isFinite(error.code)) {
      const status = Math.trunc(error.code);
      return new ModelCallError(
        `Gemini 流中错误: HTTP ${status}${message === '' ? '' : `: ${message}`}`,
        { status, retryable: ModelHttpErrors.retryableOf(status) },
      );
    }
    return ModelHttpErrors.streamError(
      'Gemini',
      typeof error.status === 'string' ? error.status : 'unknown',
      message,
    );
  }

  /**
   * 把未知数值窄化为正整数。
   * @param raw 任意值。
   * @returns 向下取整的正数；非法/非正时为 undefined。
   */
  public static positiveInt(raw: number | undefined): number | undefined {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      return undefined;
    }
    const value = Math.floor(raw);
    return value > 0 ? value : undefined;
  }
}
