import type {
  ModelMessage,
  ModelOutput,
  ModelPort,
  ModelRequest,
  ModelResponseFormat,
  ModelToolCallRef,
  ModelToolSpec,
  ModelUsage,
  StreamCallbacks,
} from '../../ports/model/model.ts';
import { ModelFinishReasons } from '../../util/modelFinishReasons.ts';
import {
  AnthropicCacheBreakpoints,
  type AnthropicWireBlock,
  type AnthropicWireMessage,
} from './anthropicCacheBreakpoints.ts';
import { PromptCacheUsageReader } from './promptCacheUsageReader.ts';
import { ModelRequestGuard } from './modelRequestGuard.ts';
import { RequestStallGuard } from './requestStallGuard.ts';
import { ModelHttpErrors } from './modelHttpErrors.ts';
import { AnthropicThinking } from './anthropicThinking.ts';
import {
  AnthropicUsage,
  type AnthropicUsageState,
  type AnthropicUsageWire,
} from './anthropicUsage.ts';
import { sseParser } from './sseParser.ts';
import { ModelResponseFormats } from './modelResponseFormats.ts';
import { ModelReasoningEfforts } from './modelReasoningEfforts.ts';
import { ToolArgumentParser } from './toolArgumentParser.ts';

/** Anthropic 模型配置。 */
export interface AnthropicModelConfig {
  /** API 基址（适配器在其后追加 /v1/messages）。 */
  readonly baseUrl: string;
  /** x-api-key 鉴权头使用的密钥。 */
  readonly apiKey: string;
  /** 模型标识（同时作为端口契约的适配器名）。 */
  readonly model: string;
  /** 单次响应的最大输出 token 数（缺省 4096）。 */
  readonly maxTokens?: number;
  /**
   * 单次请求的**空闲**超时（毫秒，可选）：连续静默超过该值即中止并抛可重试错误。
   * 优先级 本字段 > 环境变量 `OMNI_MODEL_REQUEST_TIMEOUT_MS` > 库级默认；`<=0` 关闭空闲超时
   * （此时仅在调用方给了 `ModelRequest.signal` 时才开守卫）。语义与 OpenAI 兼容适配器同一口径。
   */
  readonly requestTimeoutMs?: number | undefined;
}

/** Anthropic Messages API 适配器（真实第二协议）。 */
export class AnthropicModel implements ModelPort {
  /** 适配器名（端口契约），取配置的模型标识（config.model）。 */
  public readonly name: string;
  /** 提示缓存读取器：Anthropic 用 `cache_read_input_tokens` 表达命中。 */
  private readonly promptCache = new PromptCacheUsageReader();
  /** 滚动缓存断点规划器：system + 最近若干轮 user 消息共 ≤4 个断点（纯函数）。 */
  private readonly cacheBreakpoints = new AnthropicCacheBreakpoints();
  /** 请求空闲超时装配器（S2）：裸 fetch 在服务端不回包时会永不 settle ⇒ 必须收敛为有界等待。 */
  private readonly guard: ModelRequestGuard;

  public constructor(
    /** 适配器配置：端点、密钥、模型标识与输出上限。 */
    private readonly config: AnthropicModelConfig,
  ) {
    this.name = config.model;
    this.guard = new ModelRequestGuard(config.requestTimeoutMs);
  }

  /** 生成响应。
   * @param request 模型请求（消息、工具规格与可选取消信号）。
   * @returns 解析后的统一输出（文本、工具调用与口径合成后的用量）；非 2xx 时抛出错误。
   */
  public async generate(request: ModelRequest): Promise<ModelOutput> {
    const guard = this.guard.open(request);
    try {
      const response = await fetch(this.endpoint(), this.buildRequest(request, guard));
      // 响应头到达即算「有进展」：为紧随其后的响应体读取续期。
      guard?.touch();
      if (!response.ok) {
        // 2026-10-03 修（审计 D1）：裸 `Error` 无 status/retryable 字段，429/5xx 永不重试。
        throw await ModelHttpErrors.from(response, 'Anthropic 请求失败');
      }
      const body = (await response.json()) as AnthropicResponse;
      return this.parseOutput(body, request.responseFormat);
    } catch (error) {
      throw this.guard.wrap(error, guard, 'Anthropic 模型请求');
    } finally {
      guard?.dispose();
    }
  }

  /** 流式生成（SSE）。
   * @param request 模型请求（消息、工具规格与可选取消信号）。
   * @param callbacks 流式回调集合：文本增量与工具参数增量实时推送。
   * @returns 流结束后的完整输出：文本按增量顺序拼接；用量由 message_start/message_delta
   *          两类事件离线累积后合成。响应体缺失时降级为非流式 generate；非 2xx 时抛出错误。
   */
  public async stream(request: ModelRequest, callbacks: StreamCallbacks): Promise<ModelOutput> {
    const guard = this.guard.open(request);
    try {
      return await this.streamRequest(request, callbacks, guard);
    } catch (error) {
      throw this.guard.wrap(error, guard, 'Anthropic 模型流式请求');
    } finally {
      guard?.dispose();
    }
  }

  /**
   * 流式生成主体（守卫生命周期由 `stream` 掌管）。
   * @param request 模型请求。
   * @param callbacks 流式回调集合。
   * @param guard 本次请求的空闲超时守卫（`undefined` = 既无空闲超时也无调用方信号）。
   * @returns 流结束后的完整输出。
   */
  private async streamRequest(
    request: ModelRequest,
    callbacks: StreamCallbacks,
    guard: RequestStallGuard | undefined,
  ): Promise<ModelOutput> {
    const response = await fetch(this.endpoint(), this.buildRequest(request, guard));
    guard?.touch();
    if (!response.ok) {
      // 2026-10-03 修（审计 D1）：同 generate 路径，结构化错误让 429/5xx 可重试。
      throw await ModelHttpErrors.from(response, 'Anthropic 流式请求失败');
    }
    const body = response.body;
    if (body === null) {
      return this.generate(request);
    }
    const chunks: string[] = [];
    const reasoningChunks: string[] = [];
    const toolBlocks: {
      index: number;
      id?: string | undefined;
      name?: string | undefined;
      partial: string;
    }[] = [];
    // 流式用量累积：message_start 给 input/cache 三段，message_delta 给 output，
    // 与 generate 路径同口径合成 ModelUsage（此前流式路径完全丢弃用量，成本护栏看不到 Anthropic 消耗）。
    const usageState: AnthropicUsageState = {};
    await sseParser.read(body, (event) => {
      // 每个 SSE 事件块都算「有进展」：只要流持续吐字，长响应就不会被空闲超时误杀。
      guard?.touch();
      this.handleEvent(event.data, callbacks, chunks, toolBlocks, usageState, reasoningChunks);
    });
    const usage = AnthropicUsage.toModelUsage(
      usageState,
      this.promptCache.readAnthropic(usageState),
    );
    const finishReason =
      typeof usageState.stop_reason === 'string' ? usageState.stop_reason : undefined;
    // 2026-10-21 修（P0）：此前只返回 text/usage，累了一路的 `toolBlocks` 被整段丢弃 ⇒
    // 默认装配 live 非空时 StepRunner 必走 stream，Claude 永远只出文本、不调工具。
    const streamed = AnthropicModel.toolCallsOfStream(toolBlocks, request.responseFormat);
    const reasoning = reasoningChunks.join('');
    const output: ModelOutput = {
      text: `${chunks.join('')}${streamed.structuredText}`,
      ...(reasoning !== '' ? { reasoning } : {}),
      ...(usageState.signature !== undefined && usageState.signature !== ''
        ? { reasoningSignature: usageState.signature }
        : {}),
      ...(streamed.toolCalls.length > 0 ? { toolCalls: streamed.toolCalls } : {}),
      ...(usage !== undefined ? { usage } : {}),
      ...(finishReason !== undefined ? { finishReason } : {}),
    };
    return output;
  }

  /**
   * 把流式累积的工具块转成统一工具调用；结构化输出的**强制工具**单独还原为文本。
   *
   * 与非流式 `parseOutput` 同一口径：强制工具（`structured_output` / schema 名）不是
   * 用户工具调用，必须从 `toolCalls` 剔除并把它的 JSON 作为正文返回，否则 harness 会去
   * 执行一个不存在的工具，而调用方永远拿不到结构化文本。
   * @param blocks 流式累积的工具块。
   * @param format 本次请求的结构化输出意图。
   * @returns `toolCalls` 与强制工具还原出的结构化文本（无则为空串）。
   */
  private static toolCallsOfStream(
    blocks: readonly {
      id?: string | undefined;
      name?: string | undefined;
      partial: string;
    }[],
    format: ModelResponseFormat | undefined,
  ): { toolCalls: ModelToolCallRef[]; structuredText: string } {
    const forced = ModelResponseFormats.toAnthropicForcedTool(format);
    const forcedName = forced === undefined ? undefined : String(forced.tool['name']);
    let structuredText = '';
    const toolCalls: ModelToolCallRef[] = [];
    for (const block of blocks) {
      if (block.id === undefined || block.name === undefined) continue;
      const parsed = ToolArgumentParser.parseDetailed(block.partial);
      if (forcedName !== undefined && block.name === forcedName) {
        structuredText += JSON.stringify(parsed.arguments);
        continue;
      }
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: parsed.arguments,
        ...(parsed.error !== undefined ? { parseError: parsed.error } : {}),
      });
    }
    return { toolCalls, structuredText };
  }

  /** 构造端点。
   * @returns Messages API 完整 URL（baseUrl 追加 /v1/messages）。
   */
  private endpoint(): string {
    return `${this.config.baseUrl}/v1/messages`;
  }

  /**
   * 构造请求。
   * @param request 模型请求（system 被剥离为独立字段并打 ephemeral 缓存断点）。
   * @param guard 本次请求的空闲超时守卫（可选）；给出时以其组合信号作为 fetch signal。
   * @returns 可直接交给 fetch 的 RequestInit（POST、协议头、JSON 请求体与可选取消信号）。
   */
  private buildRequest(request: ModelRequest, guard?: RequestStallGuard): RequestInit {
    const { system, messages } = this.splitSystem(request.messages);
    return {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(
        this.wireBody(
          system,
          messages,
          request.tools,
          request.responseFormat,
          request.reasoningEffort,
          request.maxOutputTokens,
        ),
      ),
      // V2：协作式取消——signal 存在时透传给 fetch，取消即中断在飞请求。
      // S2：改为守卫的组合信号（空闲超时 ∪ 调用方取消），二者任一触发都中断在飞请求。
      ...(guard !== undefined
        ? { signal: guard.signal }
        : request.signal !== undefined
          ? { signal: request.signal }
          : {}),
    };
  }

  /**
   * 组装请求体：system 独立成 text block，消息侧按**滚动窗口**打缓存断点。
   *
   * 前缀稳定性：断点只**追加/前移**，不重排消息顺序、不插入动态内容，
   * 因此第 N 轮发出的前缀在第 N+1 轮仍是逐字节前缀（`prefix-stability.mjs` 度量的不变量）。
   *
   * @param system 剥离出的 system 文本（undefined 表示无 system 段）。
   * @param messages 已剥离 system 的 wire 消息（tool 角色已映射为 user）。
   * @param tools 统一工具规格列表（转 Anthropic tools 结构）。
   * @returns 可直接 JSON.stringify 的请求体对象。
   */
  private wireBody(
    system: string | undefined,
    messages: readonly AnthropicWireMessage[],
    tools: readonly ModelToolSpec[],
    format?: ModelResponseFormat,
    effort?: string,
    maxOutputTokens?: number,
  ): Record<string, unknown> {
    const plan = this.cacheBreakpoints.plan(messages, system !== undefined);
    // 结构化输出（2026-10-11）：Anthropic **没有** response_format 一类字段，等价实现是
    // 「注入一个 input_schema=schema 的工具 + tool_choice 强制它」。见 ModelResponseFormats。
    const forced = ModelResponseFormats.toAnthropicForcedTool(format);
    const wireTools = this.toTools(tools);
    // 推理强度（2026-10-11）：Anthropic 用 `thinking:{type:'enabled',budget_tokens}`，
    // 且**硬约束 max_tokens > budget_tokens** —— 故这里同时抬高 max_tokens（见 ModelReasoningEfforts）。
    const thinking = ModelReasoningEfforts.toAnthropic(effort);
    // Anthropic 硬约束 max_tokens > thinking.budget_tokens：调用方的上限不得低于该地板。
    const defaultMaxTokens = ModelReasoningEfforts.anthropicMaxTokens(
      effort,
      this.config.maxTokens,
    );
    const cappedMaxTokens =
      typeof maxOutputTokens === 'number' && Number.isFinite(maxOutputTokens) && maxOutputTokens > 0
        ? Math.max(Math.floor(maxOutputTokens), defaultMaxTokens)
        : defaultMaxTokens;
    return {
      model: this.config.model,
      max_tokens: cappedMaxTokens,
      ...(thinking === undefined ? {} : thinking),
      // V2.1（C10 prompt caching）：system 作为独立 text block 并打上 ephemeral
      // 缓存断点——system 前缀跨回合稳定（不变内容 + 追加），命中缓存可省重复
      // 计费 token。Anthropic 专属字段；system 缺省时保持原行为（不带该字段）。
      ...(system !== undefined
        ? {
            system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
          }
        : {}),
      messages: plan.messages,
      tools: forced === undefined ? wireTools : [...wireTools, forced.tool],
      ...(forced === undefined ? {} : { tool_choice: forced.toolChoice }),
    };
  }

  /** 请求头。
   * @returns 含 content-type、x-api-key 鉴权与 anthropic-version 协议版本的头集合。
   */
  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-api-key': this.config.apiKey,
      'anthropic-version': '2023-06-01',
    };
  }

  /**
   * 拆分 system 消息（Anthropic 用独立字段，且 `messages` 里**没有** system 角色）。
   *
   * **只有开头连续的 system 消息**才提升进顶层 `system` 字段；出现在事件历史**之后**的
   * system 消息（典型：每步随查询变化的 repo-map 尾段、运行期提示）**留在原位**并降级为
   * `user` 消息。理由是一条物理事实：Anthropic 的提示缓存只复用**字节级公共前缀**，而顶层
   * `system` 排在**所有消息之前**——一旦把逐步变化的尾段提升上去，其后整段事件历史（提示里
   * 的大头）每一步都会重新计费。`StepContextBuilder` 已按「固定头 → 事件历史 → 动态尾段」
   * 排布（P_prefix 治理），若这里把尾段搬回最前，等于在 wire 层把该治理**静默撤销**。
   *
   * 现场度量（同一 fixture，`tests/unit/anthropicWirePrefix.test.ts`）：提升时整请求前缀复用率
   * **~17%**；留在原位后 **≥ 90%**。零信息损失（内容逐字节不变，只换承载角色与位置）。
   *
   * @param messages 统一消息列表。
   * @returns system 文本（开头无 system 消息时为 undefined）与剥离后的 wire 消息数组
   *          （tool 角色映射为 user 以兼容 Anthropic 协议；非开头的 system 同样降级为 user）。
   */
  private splitSystem(messages: readonly ModelMessage[]): {
    system?: string | undefined;
    messages: AnthropicWireMessage[];
  } {
    let head = 0;
    while (head < messages.length && messages[head]?.role === 'system') {
      head += 1;
    }
    const system = messages
      .slice(0, head)
      .map((message) => message.content)
      .join('\n');
    const rest = messages.slice(head).map((message) => ({
      // assistant 保持原角色；user / tool / 非开头 system 一律映射为 user。
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: this.toWireContent(message),
    }));
    return { system: system === '' ? undefined : system, messages: rest };
  }

  /**
   * 构造单条消息的 content：无图像时保持原字符串（向后兼容）；
   * 含图像时构造为 [text, ...image] 数组（#B1）。
   * @param message 统一消息（可能携带图像与文件附件）。
   * @returns 纯文本时返回字符串；含视觉输入时返回 [text, ...image, ...附件说明] 分段数组，
   *          图像以 url 或 base64 source 表达，非图片文件降级为文本说明。
   */
  private toWireContent(message: ModelMessage): string | AnthropicWireBlock[] {
    const thinkingBlocks =
      message.role === 'assistant' ? AnthropicThinking.wireBlocks(message) : undefined;
    if (thinkingBlocks !== undefined) return thinkingBlocks;
    const images = message.images;
    const imageFiles = (message.files ?? []).filter((f) => f.mediaType.startsWith('image/'));
    const textFiles = (message.files ?? []).filter((f) => !f.mediaType.startsWith('image/'));
    if (
      (images === undefined || images.length === 0) &&
      imageFiles.length === 0 &&
      textFiles.length === 0
    ) {
      return message.content;
    }
    const blocks: AnthropicWireBlock[] = [{ type: 'text', text: message.content }];
    for (const image of images ?? []) {
      if (image.url !== undefined) {
        blocks.push({ type: 'image', source: { type: 'url', url: image.url } });
      } else if (image.data !== undefined) {
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: image.mediaType ?? 'application/octet-stream',
            data: image.data,
          },
        });
      } else {
        blocks.push({ type: 'text', text: '[图片不可用] 文件内容已不可读，请让用户重新附加。' });
      }
    }
    for (const file of imageFiles) {
      if (file.url !== undefined) {
        blocks.push({ type: 'image', source: { type: 'url', url: file.url } });
      } else if (file.data !== undefined) {
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: file.mediaType, data: file.data },
        });
      } else {
        blocks.push({
          type: 'text',
          text: `[附件不可用] ${file.name}（${file.mediaType}）：文件内容已不可读，请让用户重新附加。`,
        });
      }
    }
    for (const file of textFiles) {
      // Anthropic 原生支持 PDF document block（base64）；其它非图片文件仍以文本说明注入。
      if (file.mediaType === 'application/pdf' && file.data !== undefined) {
        blocks.push({
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: file.data },
        });
      } else if (file.data === undefined && file.url === undefined) {
        blocks.push({
          type: 'text',
          text: `[附件不可用] ${file.name}（${file.mediaType}）：文件内容已不可读，请让用户重新附加。`,
        });
      } else {
        blocks.push({ type: 'text', text: `[附件] ${file.name} (${file.mediaType})` });
      }
    }
    return blocks;
  }

  /** 工具转 Anthropic 格式。
   * @param tools 统一工具规格列表。
   * @returns Anthropic tools 数组（name/description/input_schema 平铺结构）。
   */
  private toTools(tools: readonly ModelToolSpec[]): unknown[] {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));
  }

  /** 解析响应。
   * @param body wire 层 JSON 响应。
   * @param format 本次请求的结构化输出意图（用于把**强制工具**的 `input` 转回文本内容）。
   * @returns 统一模型输出：text 块拼接、tool_use 块转工具调用引用、usage 按缓存口径合成；
   *          各段为空/缺失时对应字段不出现在输出中。
   */
  private parseOutput(body: AnthropicResponse, format?: ModelResponseFormat): ModelOutput {
    const text = body.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
    // 结构化输出（2026-10-11）：Anthropic 侧我们**自己注入**了强制工具（见 wireBody）——
    // 那条 tool_use 不是用户工具调用，必须转成 JSON 文本内容并**从 toolCalls 里剔除**：
    // 否则 harness 会去执行一个名叫 `structured_output` / schema 名的"工具"（不存在 ⇒ 失败），
    // 而调用方想要的结构化文本永远拿不到。
    const forced = ModelResponseFormats.toAnthropicForcedTool(format);
    const forcedName = forced === undefined ? undefined : String(forced.tool['name']);
    const forcedBlock =
      forcedName === undefined
        ? undefined
        : body.content.find(
            (block): block is ToolUseBlock =>
              block.type === 'tool_use' && block.name === forcedName,
          );
    const structuredText = forcedBlock === undefined ? '' : JSON.stringify(forcedBlock.input ?? {});
    const toolCalls = body.content
      .filter(
        (block): block is ToolUseBlock =>
          block.type === 'tool_use' && !(forcedName !== undefined && block.name === forcedName),
      )
      .map((block) => ({
        id: block.id,
        name: block.name,
        arguments: block.input as Record<string, unknown>,
      }));
    const usage = AnthropicUsage.toModelUsage(
      body.usage,
      this.promptCache.readAnthropic(body.usage),
    );
    // 扩展思考：thinking 块只入 reasoning（不进正文），signature 供下一轮原样回传。
    const thinking = AnthropicThinking.parse(body.content);
    const output: {
      text?: string;
      reasoning?: string;
      reasoningSignature?: string;
      toolCalls?: readonly ModelToolCallRef[];
      usage?: ModelUsage;
      finishReason?: string;
    } = {};
    // LR-01：Anthropic 用 `stop_reason`（`max_tokens` 即截断）表达结束原因；保留给恢复层。
    // 2026-10-21：必须**归一化**为统一值（`max_tokens` → `length`），否则 StepRunner 的
    // 截断续写只认 `length`，会把 Anthropic 的半截输出当成正常完成。
    if (typeof body.stop_reason === 'string' && body.stop_reason !== '') {
      output.finishReason = ModelFinishReasons.normalize(body.stop_reason) ?? body.stop_reason;
    }
    const mergedText = `${text}${structuredText}`;
    if (mergedText !== '') {
      output.text = mergedText;
    }
    if (thinking.thinking !== undefined) {
      output.reasoning = thinking.thinking;
    }
    if (thinking.signature !== undefined) {
      output.reasoningSignature = thinking.signature;
    }
    if (toolCalls.length > 0) {
      output.toolCalls = toolCalls;
    }
    if (usage !== undefined) {
      output.usage = usage;
    }
    return output;
  }

  /** 处理流式事件。
   * @param data SSE 已分帧的事件 data 负载（JSON 文本；[DONE] 直接忽略）。
   * @param callbacks 流式回调集合：text_delta 经 onText、工具块开始/参数增量经 onToolInput 推出。
   * @param chunks 跨事件累积的文本增量（就地追加）。
   * @param toolBlocks 跨事件累积的工具调用块（按流中顺序入栈，就地更新 partial）。
   * @param usageState 跨事件累积的用量状态（经 observeUsage 原地覆盖写）。
   
   * @returns 无返回值。
   */
  private handleEvent(
    data: string,
    callbacks: StreamCallbacks,
    chunks: string[],
    toolBlocks: {
      index: number;
      id?: string | undefined;
      name?: string | undefined;
      partial: string;
    }[],
    usageState: AnthropicUsageState,
    reasoningChunks: string[],
  ): void {
    if (data === '[DONE]') {
      return;
    }
    const json = JSON.parse(data) as AnthropicStreamEvent;
    // 流中 error 事件（2026-10-03 修，审计 D3）：Anthropic 规范允许流中途发
    // `event: error`（如 overloaded_error）；旧实现只处理 content_block 两类事件，
    // 错误负载被静默丢弃 ⇒ 半截文本/半截工具参数被当成成功输出。
    if (json.type === 'error') {
      throw ModelHttpErrors.streamError(
        'Anthropic',
        json.error?.type ?? 'unknown',
        json.error?.message ?? '',
      );
    }
    AnthropicUsage.observe(json, usageState);
    // LR-01：`message_delta` 的 stop_reason 是流式结束原因（max_tokens = 截断）。
    if (json.type === 'message_delta' && typeof json.delta?.stop_reason === 'string') {
      usageState.stop_reason = ModelFinishReasons.normalize(json.delta.stop_reason);
    }
    // #B3 工具调用开始：记录 id/name，先推一次空增量（便于 UI 立即显示「调用中」）。
    if (json.type === 'content_block_start' && json.content_block?.type === 'tool_use') {
      const index = json.index ?? toolBlocks.length;
      toolBlocks.push({
        index,
        id: json.content_block.id,
        name: json.content_block.name,
        partial: '',
      });
      callbacks.onToolInput?.({
        id: json.content_block.id,
        name: json.content_block.name,
        partialJson: '',
      });
      return;
    }
    // #B3 工具参数渐进增量（Anthropic 的 content_block.index 未必从 0 连续，
    // 工具块在流中顺序出现，故取最后入栈的块即可正确累积）。
    if (json.type === 'content_block_delta' && json.delta?.type === 'input_json_delta') {
      const block = toolBlocks[toolBlocks.length - 1];
      if (block !== undefined) {
        block.partial += json.delta.partial_json ?? '';
        callbacks.onToolInput?.({ id: block.id, name: block.name, partialJson: block.partial });
      }
      return;
    }
    if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta') {
      const text = json.delta?.text ?? '';
      callbacks.onText(text);
      chunks.push(text);
      return;
    }
    // 扩展思考（thinking）：只收集、不进正文；随输出 `reasoning` 回传，UI/日志可见。
    // Anthropic 的 signature 也需回传才能续接 thinking 块，但当前端口没有签名字段，
    // 故这里只保留文本（工具轮里的思考块回传属后续能力，见端口 ModelMessage.reasoningContent）。
    if (json.type === 'content_block_delta' && json.delta?.type === 'signature_delta') {
      const signature = json.delta.signature ?? '';
      if (signature !== '') usageState.signature = signature;
      return;
    }
    if (json.type === 'content_block_delta' && json.delta?.type === 'thinking_delta') {
      const thinking = json.delta.thinking ?? '';
      if (thinking !== '') reasoningChunks.push(thinking);
    }
  }
}

/** Anthropic 响应类型。 */
interface AnthropicResponse {
  readonly content: readonly (TextBlock | ToolUseBlock | ThinkingBlock)[];
  /** 结束原因（`max_tokens` = 输出被截断；LR-01）。 */
  readonly stop_reason?: string | null;
  /** token 用量（#S29；`input_tokens` 不含缓存两段，见 usageOf 的口径说明）。 */
  readonly usage?: AnthropicUsageWire;
}

/** 文本块。 */
interface TextBlock {
  readonly type: 'text';
  readonly text: string;
}

/** 工具使用块。 */
interface ToolUseBlock {
  readonly type: 'tool_use';
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

/** 思考块（扩展思考；signature 必须原样回传才能续接）。 */
interface ThinkingBlock {
  readonly type: 'thinking';
  readonly thinking: string;
  readonly signature?: string;
}

/** 流式事件（最小子集）。 */
interface AnthropicStreamEvent {
  readonly type: string;
  readonly index?: number;
  readonly delta?: {
    type: string;
    text?: string;
    partial_json?: string;
    thinking?: string;
    signature?: string;
    stop_reason?: string | null;
  };
  readonly content_block?: { type: string; id?: string; name?: string; input?: unknown };
  /** `message_start` 携带首段用量（含缓存两段）。 */
  readonly message?: { readonly usage?: AnthropicUsageWire };
  /** `message_delta` 携带 output 累计量。 */
  readonly usage?: AnthropicUsageWire;
  /** 流中 error 事件负载（2026-10-03 修 D3；出现即中断流并上抛结构化错误）。 */
  readonly error?: { readonly type?: string; readonly message?: string };
}
