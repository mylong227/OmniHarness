import type {
  ModelMessage,
  ModelOutput,
  ModelPort,
  ModelRequest,
  ModelToolCallRef,
  ModelUsage,
  StreamCallbacks,
} from '../../ports/model/model.ts';
import { ModelCallError } from '../../ports/model/model.ts';
import { ToolRoundSanitizer } from '../../util/toolRoundSanitizer.ts';
import { ModelHttpErrors } from './modelHttpErrors.ts';
import { ModelRequestGuard } from './modelRequestGuard.ts';
import type { RequestStallGuard } from './requestStallGuard.ts';
import { sseParser } from './sseParser.ts';
import { GeminiWire } from './geminiWire.ts';
import type {
  GeminiContent,
  GeminiResponse,
  GeminiRole,
  GeminiStreamFrame,
  GeminiStreamState,
  GeminiWirePart,
  MessageWithAttachments,
} from './geminiTypes.ts';

/** Gemini 官方 v1beta 基址（配置缺省时使用；CLI 路径由 `defaults/endpoints.json` 提供同值）。 */
const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/** 兜底模型（仅在配置与 `GEMINI_MODEL` 都未给出时使用；该模型在价目表内有登记）。 */
const DEFAULT_MODEL = 'gemini-2.5-flash';

/** 读取 API Key 的环境变量名（按优先级排列）。 */
const API_KEY_ENV_KEYS = ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] as const;

/** Gemini 模型配置。 */
export interface GeminiModelConfig {
  /** API Key；缺省时依次读 `GEMINI_API_KEY` / `GOOGLE_API_KEY`，仍缺即 fail-closed。 */
  readonly apiKey?: string | undefined;
  /** API 基址（缺省 `https://generativelanguage.googleapis.com/v1beta`；未带版本段时自动补）。 */
  readonly baseUrl?: string | undefined;
  /** 模型标识（如 `gemini-2.5-flash`；也可写资源名 `models/gemini-2.5-flash`）。 */
  readonly model: string;
  /** 单次请求的**空闲**超时（毫秒）；`<=0` 关闭空闲超时（仍支持调用方取消）。 */
  readonly timeoutMs?: number | undefined;
  /** `timeoutMs` 的兼容别名（与其余适配器的 `requestTimeoutMs` 同名，二者取其一）。 */
  readonly requestTimeoutMs?: number | undefined;
  /** 请求未显式给 `maxOutputTokens` 时使用的默认输出上限。 */
  readonly maxOutputTokens?: number | undefined;
  /** 请求未显式给 `reasoningEffort` 时使用的默认推理档位。 */
  readonly reasoningEffort?: string | undefined;
}

/**
 * Google Gemini 原生适配器（`generateContent` / `streamGenerateContent?alt=sse`）。
 *
 * ## 为什么单独成适配器
 *
 * `defaults/providers.json` 的 gemini 预设走 OpenAI 兼容层，与原生协议是两条通路；原生协议才支持
 * `thinkingBudget` / `functionDeclarations` / `cachedContentTokenCount`，本类补齐缺口且不影响既有预设。
 *
 * ## 协议要点（实现依据）
 *
 * - 鉴权用 `x-goog-api-key`；角色只有 `user` / `model`，system 走顶层 `systemInstruction`；
 * - 工具：`tools[0].functionDeclarations`；结果回传为 `functionResponse`（按 `name`/`id` 配对）；
 * - 流式：SSE，每帧是一个**增量** `GenerateContentResponse`；`usageMetadata` 以末帧为准。
 */
export class GeminiModel implements ModelPort {
  /** 适配器名（端口契约；本适配器固定为 `gemini`）。 */
  public readonly name = 'gemini';
  /** 解析后的 API Key（构造期已 trim 并完成 fail-closed 校验）。 */
  private readonly apiKey: string;
  /** 解析后的基址（已去尾部斜杠）。 */
  private readonly baseUrl: string;
  /** 生效模型标识（已按「配置 > GEMINI_MODEL > 兜底」解析）。 */
  private readonly model: string;
  /** 请求未显式给出时使用的输出上限。 */
  private readonly maxOutputTokens: number | undefined;
  /** 请求未显式给出时使用的推理档位。 */
  private readonly reasoningEffort: string | undefined;
  /** 请求空闲超时装配器（与 OpenAI / Anthropic / Responses / llama.cpp 共用同一份语义）。 */
  private readonly guard: ModelRequestGuard;

  /**
   * @param config 适配器配置（Key / 基址 / 模型 / 超时 / 输出上限 / 推理档位）。
   * @throws Error API Key 缺失时抛出（消息列出两个环境变量与 `--api-key` 出口）。
   */
  public constructor(config: GeminiModelConfig) {
    const envKey = API_KEY_ENV_KEYS.map((key) => (process.env[key] ?? '').trim()).find(
      (value) => value !== '',
    );
    const apiKey = (config.apiKey ?? '').trim() || envKey || '';
    if (apiKey === '') {
      throw new Error(
        'Gemini 适配器需要 API Key：请设置 GEMINI_API_KEY 或 GOOGLE_API_KEY 环境变量，' +
          '或通过 --api-key / omniharness.json 的 apiKey 传入（fail-closed，不会发出无凭据请求）',
      );
    }
    this.apiKey = apiKey;
    const rawBase =
      (config.baseUrl ?? '').trim() ||
      (process.env['GEMINI_BASE_URL'] ?? '').trim() ||
      DEFAULT_BASE_URL;
    this.baseUrl = rawBase.replace(/\/+$/u, '');
    const configuredModel = config.model.trim();
    const envModel = (process.env['GEMINI_MODEL'] ?? '').trim();
    this.model =
      configuredModel !== '' ? configuredModel : envModel !== '' ? envModel : DEFAULT_MODEL;
    this.maxOutputTokens = GeminiWire.positiveInt(config.maxOutputTokens);
    this.reasoningEffort = config.reasoningEffort;
    this.guard = new ModelRequestGuard(config.timeoutMs ?? config.requestTimeoutMs);
  }

  /**
   * 非流式生成。
   * @param request 模型请求（消息、工具、推理档位、温度、输出上限与取消信号）。
   * @returns 统一输出（文本 / 思考 / 工具调用 / 用量 / 结束原因）；非 2xx 抛结构化错误。
   */
  public async generate(request: ModelRequest): Promise<ModelOutput> {
    const guard = this.guard.open(request);
    try {
      const response = await fetch(this.endpoint(false), this.buildRequest(request, guard, false));
      // 响应头到达即算「有进展」：为紧随其后的响应体读取续期。
      guard?.touch();
      if (!response.ok) {
        throw await ModelHttpErrors.from(response, 'Gemini 请求失败');
      }
      const body = (await response.json()) as GeminiResponse;
      return this.parseOutput(body);
    } catch (error) {
      throw this.guard.wrap(error, guard, 'Gemini 模型请求');
    } finally {
      guard?.dispose();
    }
  }

  /**
   * 流式生成（SSE）。
   * @param request 模型请求（消息、工具、推理档位、温度、输出上限与取消信号）。
   * @param callbacks 流式回调：文本增量走 `onText`，工具参数走 `onToolInput`。
   * @returns 流结束后的完整输出（文本/思考拼接、工具调用、末帧用量、结束原因）。
   *          响应体缺失或帧格式非法时 fail-closed 抛错，不伪造空成功。
   */
  public async stream(request: ModelRequest, callbacks: StreamCallbacks): Promise<ModelOutput> {
    const guard = this.guard.open(request);
    try {
      const response = await fetch(this.endpoint(true), this.buildRequest(request, guard, true));
      guard?.touch();
      if (!response.ok) {
        throw await ModelHttpErrors.from(response, 'Gemini 流式请求失败');
      }
      const body = response.body;
      if (body === null) {
        // 明确 fail-closed：没有响应体就无法区分「空回复」与「传输被截断」。
        throw new ModelCallError('Gemini 流式响应缺少响应体（fail-closed）', {
          retryable: false,
        });
      }
      const state: GeminiStreamState = {
        textChunks: [],
        reasoningChunks: [],
        calls: [],
        toolCounts: new Map(),
        usage: undefined,
        finishReason: undefined,
      };
      await sseParser.read(body, (event) => {
        // 每个 SSE 事件块都算「有进展」：长响应只要持续吐字就不会被空闲超时误杀。
        guard?.touch();
        this.handleStreamEvent(event.data, callbacks, state);
      });
      const text = state.textChunks.join('');
      const reasoning = state.reasoningChunks.join('');
      return {
        ...(text !== '' ? { text } : {}),
        ...(reasoning !== '' ? { reasoning } : {}),
        ...(state.calls.length > 0 ? { toolCalls: state.calls } : {}),
        ...(state.usage !== undefined ? { usage: state.usage } : {}),
        ...(state.finishReason !== undefined ? { finishReason: state.finishReason } : {}),
      };
    } catch (error) {
      throw this.guard.wrap(error, guard, 'Gemini 模型流式请求');
    } finally {
      guard?.dispose();
    }
  }

  /**
   * 构造端点 URL。
   * @param stream 是否走 SSE 流式方法。
   * @returns 完整 URL（基址未带版本段时补 `/v1beta`；模型资源名按段编码）。
   */
  private endpoint(stream: boolean): string {
    const versioned = /\/v\d+(?:beta\d*)?$/u.test(this.baseUrl)
      ? this.baseUrl
      : `${this.baseUrl}/v1beta`;
    const resource = /^(?:models|tunedModels)\//u.test(this.model)
      ? this.model
      : `models/${this.model}`;
    const path = resource
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    return `${versioned}/${path}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`;
  }

  /**
   * 构造 fetch 请求。
   * @param request 模型请求。
   * @param guard 本次请求的空闲超时守卫（可为 undefined）。
   * @param stream 是否流式。
   * @returns POST RequestInit（JSON 请求体、`x-goog-api-key` 鉴权与可选取消信号）。
   */
  private buildRequest(
    request: ModelRequest,
    guard: RequestStallGuard | undefined,
    stream: boolean,
  ): RequestInit {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-goog-api-key': this.apiKey,
    };
    if (stream) {
      headers['accept'] = 'text/event-stream';
    }
    return {
      method: 'POST',
      headers,
      body: JSON.stringify(this.bodyOf(request)),
      ...(guard !== undefined
        ? { signal: guard.signal }
        : request.signal !== undefined
          ? { signal: request.signal }
          : {}),
    };
  }

  /**
   * 组装 `generateContent` / `streamGenerateContent` 请求体。
   * @param request 模型请求。
   * @returns 可直接 JSON 序列化的请求体。
   * @throws Error contents 为空或推理档位未登记时抛出（fail-closed）。
   */
  private bodyOf(request: ModelRequest): Record<string, unknown> {
    const { system, contents } = this.contentsOf(request.messages);
    if (contents.length === 0) {
      throw new Error('Gemini 请求缺少可发送的 messages（contents 为空，fail-closed）');
    }
    const body: Record<string, unknown> = { contents };
    if (system !== undefined) {
      body['systemInstruction'] = { parts: [{ text: system }] };
    }
    if (request.tools.length > 0) {
      body['tools'] = [{ functionDeclarations: GeminiWire.functionDeclarations(request.tools) }];
    }
    const generation = this.generationConfigOf(request);
    if (generation !== undefined) {
      body['generationConfig'] = generation;
    }
    return body;
  }

  /**
   * 把统一消息转换为 Gemini `contents`。
   *
   * 与 Anthropic 适配器同一口径：**只有开头连续的 system 消息**提升到 `systemInstruction`；
   * 事件历史之后的 system 消息留在原位降级为 user 内容，以保住可复用的字节级公共前缀。
   * 工具轮次先经 `ToolRoundSanitizer` 规整（丢弃孤儿 tool 结果），避免上游 400。
   * @param messages 统一消息列表。
   * @returns system 指令（无则 undefined）与已按角色合并相邻项的 contents。
   */
  private contentsOf(messages: readonly ModelMessage[]): {
    system?: string | undefined;
    contents: GeminiContent[];
  } {
    const sanitized = ToolRoundSanitizer.sanitizeToolRounds(messages);
    let head = 0;
    while (head < sanitized.length && sanitized[head]?.role === 'system') {
      head += 1;
    }
    const systemText = sanitized
      .slice(0, head)
      .map((message) => message.content)
      .join('\n')
      .trim();
    const nameById = new Map<string, string>();
    for (const message of sanitized) {
      for (const call of message.toolCalls ?? []) {
        nameById.set(call.id, call.name);
      }
    }
    const contents: GeminiContent[] = [];
    for (const message of sanitized.slice(head)) {
      const role: GeminiRole = message.role === 'assistant' ? 'model' : 'user';
      const parts = this.partsOf(message, nameById);
      if (parts.length === 0) {
        continue;
      }
      const previous = contents[contents.length - 1];
      if (previous !== undefined && previous.role === role) {
        previous.parts.push(...parts);
      } else {
        contents.push({ role, parts });
      }
    }
    return {
      ...(systemText === '' ? {} : { system: systemText }),
      contents,
    };
  }

  /**
   * 转换单条消息的内容分片。
   * @param message 统一消息。
   * @param nameById 工具调用 id → 工具名（供 functionResponse 与前置 functionCall 配对）。
   * @returns Gemini parts（空数组表示该消息无需发送）。
   */
  private partsOf(message: ModelMessage, nameById: ReadonlyMap<string, string>): GeminiWirePart[] {
    if (message.role === 'assistant') {
      const parts: GeminiWirePart[] = [];
      if (message.content !== '') {
        parts.push({ text: message.content });
      }
      for (const call of message.toolCalls ?? []) {
        parts.push({
          functionCall: {
            id: call.id,
            name: call.name,
            args: call.arguments,
            ...(call.thoughtSignature !== undefined && call.thoughtSignature !== ''
              ? { thoughtSignature: call.thoughtSignature }
              : {}),
          },
        });
      }
      return parts;
    }
    if (message.role === 'tool') {
      const name = message.toolCallId === undefined ? undefined : nameById.get(message.toolCallId);
      if (message.toolCallId !== undefined && name !== undefined) {
        return [
          {
            functionResponse: {
              id: message.toolCallId,
              name,
              response: { result: message.content },
            },
          },
        ];
      }
      // 兜底（正常链路已被 sanitizeToolRounds 过滤）：无法配对的结果降级为文本，绝不伪造配对。
      return [{ text: `[工具结果] ${message.content}` }];
    }
    const parts: GeminiWirePart[] = [];
    if (message.content !== '') {
      parts.push({ text: message.content });
    }
    parts.push(...this.attachmentParts(message));
    return parts;
  }

  /**
   * 把图像 / 文件附件转换为 Gemini 的 `inlineData` 分片。
   *
   * 诚实边界：Gemini 原生 API 只接受**内联 base64** 或 Files API 上传后的 `fileData`，
   * 因此 http(s) / file:// 形式的附件在此降级为文本说明（不伪装成可用输入）。
   * @param message 统一消息（可能携带 images / files）。
   * @returns inlineData 或降级说明文本分片。
   */
  private attachmentParts(message: MessageWithAttachments): GeminiWirePart[] {
    const parts: GeminiWirePart[] = [];
    for (const image of message.images ?? []) {
      const inline = GeminiWire.inlineDataOf(image.url, image.data, image.mediaType);
      parts.push(
        inline === undefined
          ? { text: '[图片不可用] 仅支持内联 base64；请重新附加或上传到 Gemini Files API。' }
          : { inlineData: inline },
      );
    }
    for (const file of message.files ?? []) {
      if (file.mediaType.startsWith('image/') || file.mediaType === 'application/pdf') {
        const inline = GeminiWire.inlineDataOf(file.url, file.data, file.mediaType);
        parts.push(
          inline === undefined
            ? {
                text: `[附件不可用] ${file.name}（${file.mediaType}）：仅支持内联 base64。`,
              }
            : { inlineData: inline },
        );
        continue;
      }
      // 非视觉文件无法作为 Gemini 原生输入：保留文件名 + MIME 的文本说明，上下文不丢。
      parts.push({ text: `[附件] ${file.name}（${file.mediaType}）` });
    }
    return parts;
  }

  /**
   * 组装 `generationConfig`（温度 / 输出上限 / 思考预算 / 结构化输出）。
   * @param request 模型请求。
   * @returns 配置对象；没有任何字段时不发该字段。
   * @throws Error 推理档位未登记时抛出（fail-closed）。
   */
  private generationConfigOf(request: ModelRequest): Record<string, unknown> | undefined {
    const config: Record<string, unknown> = {};
    const maxOutputTokens = GeminiWire.positiveInt(request.maxOutputTokens) ?? this.maxOutputTokens;
    if (maxOutputTokens !== undefined) {
      config['maxOutputTokens'] = maxOutputTokens;
    }
    if (typeof request.temperature === 'number' && Number.isFinite(request.temperature)) {
      config['temperature'] = request.temperature;
    }
    const effort = request.reasoningEffort ?? this.reasoningEffort;
    const thinking = GeminiWire.thinkingConfigOf(
      effort,
      GeminiWire.thinkingBudgetCapFor(this.model),
    );
    if (thinking !== undefined) {
      config['thinkingConfig'] = thinking;
    }
    const format = GeminiWire.responseFormatOf(request.responseFormat);
    if (format !== undefined) {
      Object.assign(config, format);
    }
    return Object.keys(config).length > 0 ? config : undefined;
  }

  /**
   * 解析非流式响应。
   * @param body Gemini `GenerateContentResponse`。
   * @returns 统一输出；无 candidate 但有 blockReason 时按 `content_filter` 收尾。
   */
  private parseOutput(body: GeminiResponse): ModelOutput {
    const candidate = body.candidates?.[0];
    const textChunks: string[] = [];
    const reasoningChunks: string[] = [];
    const calls: ModelToolCallRef[] = [];
    const toolCounts = new Map<string, number>();
    for (const part of candidate?.content?.parts ?? []) {
      if (typeof part.text === 'string' && part.text !== '') {
        if (part.thought === true) {
          reasoningChunks.push(part.text);
        } else {
          textChunks.push(part.text);
        }
      }
      if (part.functionCall !== undefined) {
        const call = GeminiWire.toolCallOf(part.functionCall, toolCounts);
        if (call !== undefined) {
          calls.push(call);
        }
      }
    }
    const output: {
      text?: string;
      reasoning?: string;
      toolCalls?: readonly ModelToolCallRef[];
      usage?: ModelUsage;
      finishReason?: string;
    } = {};
    const text = textChunks.join('');
    const reasoning = reasoningChunks.join('');
    if (text !== '') {
      output.text = text;
    }
    if (reasoning !== '') {
      output.reasoning = reasoning;
    }
    if (calls.length > 0) {
      output.toolCalls = calls;
    }
    const usage = GeminiWire.usageOf(body.usageMetadata);
    if (usage !== undefined) {
      output.usage = usage;
    }
    const finishReason =
      GeminiWire.finishReasonOf(candidate?.finishReason) ??
      (body.promptFeedback?.blockReason === undefined ? undefined : 'content_filter');
    if (finishReason !== undefined) {
      output.finishReason = finishReason;
    }
    return output;
  }

  /**
   * 处理单个 SSE 帧（text / functionCall / usageMetadata / finishReason / error）。
   * @param data SSE `data:` 负载（JSON 文本；`[DONE]` 忽略）。
   * @param callbacks 流式回调。
   * @param state 跨帧累积状态（就地更新）。
   * @returns 无返回值。
   * @throws ModelCallError 帧非法或携带流中错误时抛出（fail-closed）。
   */
  private handleStreamEvent(
    data: string,
    callbacks: StreamCallbacks,
    state: GeminiStreamState,
  ): void {
    if (data === '[DONE]') {
      return;
    }
    let frame: GeminiStreamFrame;
    try {
      frame = JSON.parse(data) as GeminiStreamFrame;
    } catch {
      throw new ModelCallError('Gemini 流式响应不是合法 JSON（fail-closed）', {
        retryable: false,
      });
    }
    if (frame.error !== undefined) {
      throw GeminiWire.streamErrorOf(frame.error);
    }
    const candidate = frame.candidates?.[0];
    for (const part of candidate?.content?.parts ?? []) {
      if (typeof part.text === 'string' && part.text !== '') {
        if (part.thought === true) {
          state.reasoningChunks.push(part.text);
        } else {
          callbacks.onText(part.text);
          state.textChunks.push(part.text);
        }
      }
      if (part.functionCall !== undefined) {
        const call = GeminiWire.toolCallOf(part.functionCall, state.toolCounts);
        if (call !== undefined) {
          const existing = state.calls.find(
            (item) => item.id === call.id && item.name === call.name,
          );
          let merged = call.arguments;
          if (existing === undefined) {
            state.calls.push(call);
          } else {
            existing.arguments = { ...existing.arguments, ...call.arguments };
            merged = existing.arguments;
          }
          callbacks.onToolInput?.({
            id: call.id,
            name: call.name,
            partialJson: JSON.stringify(merged),
          });
        }
      }
    }
    const usage = GeminiWire.usageOf(frame.usageMetadata);
    if (usage !== undefined) {
      state.usage = usage;
    }
    const finishReason =
      GeminiWire.finishReasonOf(candidate?.finishReason) ??
      (frame.promptFeedback?.blockReason === undefined ? undefined : 'content_filter');
    if (finishReason !== undefined) {
      state.finishReason = finishReason;
    }
  }
}
