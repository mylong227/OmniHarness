import type {
  ImageContent,
  ModelMessage,
  ModelOutput,
  ModelPort,
  ModelRequest,
  ModelToolCallRef,
  ModelToolSpec,
  ModelUsage,
  StreamCallbacks,
} from '../../ports/model/model.js';
import { ModelHttpErrors } from './modelHttpErrors.js';
import { ModelRequestGuard } from './modelRequestGuard.js';
import { log } from '../../util/logger.js';
import { RequestStallGuard } from './requestStallGuard.js';

/**
 * @beta
 * 本地模型原生适配器（B5）：对接 Ollama / llama.cpp 原生协议。
 *
 * 端点：`<baseUrl>/api/chat`（Ollama 原生 chat 协议，也是本地模型最成熟、且原生支持
 * 工具调用与流式（NDJSON）的端口）。llama.cpp 的 `server` 同时提供 OpenAI 兼容的
 * `/v1`，那类端点直接走 `openai` 适配器 + `--base-url` 即可；本适配器补齐「原生」缺口。
 *
 * 默认 baseUrl = http://localhost:11434（Ollama 默认端口），无需外网、零密钥即可跑。
 */
export interface LlamaCppConfig {
  /** 本地服务基址，如 http://localhost:11434。 */
  readonly baseUrl: string;
  /** 模型名，如 llama3 / qwen2.5。 */
  readonly model: string;
  /** 可选鉴权（vLLM 等需 Bearer）。Ollama 通常留空。 */
  readonly apiKey?: string | undefined;
  /**
   * 单次请求的**空闲**超时（毫秒，可选）：连续静默超过该值即中止并抛可重试错误。
   * 优先级 本字段 > 环境变量 `OMNI_MODEL_REQUEST_TIMEOUT_MS` > 库级默认；`<=0` 关闭空闲超时。
   */
  readonly requestTimeoutMs?: number | undefined;
}

/**
 * @beta
 * 本地模型（Ollama / llama.cpp 原生 `/api/chat`）适配器。
 */
export class LlamaCppModel implements ModelPort {
  /** 适配器名（端口契约），取配置的模型标识（config.model）。 */
  public readonly name: string;
  /** 适配器配置：本地服务基址、模型名与可选鉴权。 */
  private readonly config: LlamaCppConfig;
  /** 请求空闲超时装配器（S2）：本地服务卡死时裸 fetch 会永不 settle ⇒ 必须收敛为有界等待。 */
  private readonly guard: ModelRequestGuard;

  public constructor(config: LlamaCppConfig) {
    this.config = config;
    this.name = config.model;
    this.guard = new ModelRequestGuard(config.requestTimeoutMs);
  }

  /** 非流式生成。
   * @param request 模型请求（消息与工具规格）。
   * @returns 解析后的统一输出（文本、工具调用与 token 用量）；非 2xx 时抛出结构化模型调用错误
   *          （由 `ModelHttpErrors.from` 构造，与其它协议共用同一套状态码分类与 `Retry-After` 解析）。
   */
  public async generate(request: ModelRequest): Promise<ModelOutput> {
    const guard = this.guard.open(request);
    try {
      const response = await fetch(
        `${this.config.baseUrl}/api/chat`,
        this.buildRequest(request, false, guard),
      );
      guard?.touch();
      if (!response.ok) {
        throw await ModelHttpErrors.from(response, '本地模型请求失败');
      }
      const body = (await response.json()) as OllamaChatResponse;
      return this.parseOutput(body);
    } catch (error) {
      throw this.guard.wrap(error, guard, '本地模型请求');
    } finally {
      guard?.dispose();
    }
  }

  /** 流式生成：Ollama 以换行分隔的 JSON 对象（NDJSON）推送，末条 done:true 收尾。
   * @param request 模型请求（消息与工具规格）。
   * @param callbacks 流式回调集合：文本增量实时推送；工具调用去重合入后不逐段回调。
   * @returns 流结束后的完整输出：文本按增量顺序拼接，工具调用跨片段合并（**有 index 按槽位分桶、
   *          字符串参数按片段累积到流末再解析**，无 index 时按函数名合并——详见 `mergeToolCalls`），
   *          id 逐条唯一；usage 取最后一个含计数字段的片段。响应体缺失时降级为非流式 generate；
   *          末尾无换行的残余 JSON 片段尽力解析，非法则忽略；非 2xx 时抛出结构化错误。
   */
  public async stream(request: ModelRequest, callbacks: StreamCallbacks): Promise<ModelOutput> {
    const guard = this.guard.open(request);
    try {
      return await this.streamRequest(request, callbacks, guard);
    } catch (error) {
      throw this.guard.wrap(error, guard, '本地模型流式请求');
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
    const response = await fetch(
      `${this.config.baseUrl}/api/chat`,
      this.buildRequest(request, true, guard),
    );
    guard?.touch();
    if (!response.ok) {
      throw await ModelHttpErrors.from(response, '本地模型流式请求失败');
    }
    const body = response.body;
    if (body === null) {
      return this.generate(request);
    }
    const chunks: string[] = [];
    const toolCalls: PipelineToolCall[] = [];
    let usage: ModelUsage | undefined;
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const piece of body) {
      // 每一块 NDJSON 数据都算「有进展」：只要流持续吐字，长响应就不会被空闲超时误杀。
      guard?.touch();
      buffer += decoder.decode(piece, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line === '') {
          continue;
        }
        const obj = JSON.parse(line) as OllamaChatStreamChunk;
        if (obj.message?.content !== undefined && obj.message.content !== '') {
          callbacks.onText(obj.message.content);
          chunks.push(obj.message.content);
        }
        if (obj.message?.tool_calls !== undefined) {
          this.mergeToolCalls(toolCalls, obj.message.tool_calls);
        }
        usage = this.usageFromChunk(obj, usage);
        if (obj.done === true) {
          break;
        }
      }
    }
    // 处理末尾未以换行刷新的残余片段。
    const tail = buffer.trim();
    if (tail !== '') {
      try {
        const obj = JSON.parse(tail) as OllamaChatStreamChunk;
        if (obj.message?.content !== undefined && obj.message.content !== '') {
          callbacks.onText(obj.message.content);
          chunks.push(obj.message.content);
        }
        if (obj.message?.tool_calls !== undefined) {
          this.mergeToolCalls(toolCalls, obj.message.tool_calls);
        }
        usage = this.usageFromChunk(obj, usage);
      } catch {
        // 截断片段忽略。
      }
    }
    const output: { text?: string; toolCalls?: ModelToolCallRef[]; usage?: ModelUsage } = {
      text: chunks.join(''),
    };
    const finalized = this.finalizeToolCalls(toolCalls);
    if (finalized.length > 0) {
      output.toolCalls = finalized;
    }
    if (usage !== undefined) {
      output.usage = usage;
    }
    return output;
  }

  /** 构造请求体。
   *
   * 消息按 Ollama `/api/chat` 的 message 契约序列化（见 {@link LlamaCppModel.toOllamaMessages}）：
   * **不再只透传 `role` + `content`**——那样会把 assistant 的 `tool_calls` 与工具结果的
   * `tool_name` 全部丢掉，使原生多轮工具对话在这一适配器上不成立（模型看不到自己调用过什么、
   * 也看不到结果对应的工具）。
   * @param request 模型请求，提供消息与工具规格。
   * @param stream true 表示 NDJSON 流式响应，false 表示一次性 JSON 响应。
   * @param guard 本次请求的空闲超时守卫（可选）；给出时以其组合信号作为 fetch signal。
   * @returns 可直接交给 fetch 的 RequestInit（POST、JSON 请求体；配置了 apiKey 时附 Bearer 头，
   *          signal 存在时透传以支持取消）。
   */
  private buildRequest(
    request: ModelRequest,
    stream: boolean,
    guard?: RequestStallGuard,
  ): RequestInit {
    const tools =
      request.tools.length > 0 ? request.tools.map((tool) => this.toOllamaTool(tool)) : undefined;
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: this.toOllamaMessages(request.messages),
      stream,
    };
    if (tools !== undefined) {
      body.tools = tools;
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey !== undefined) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }
    return {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
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
   * 把统一消息序列化为 Ollama `/api/chat` 的 message 对象（多轮工具对话的**请求侧**契约）。
   *
   * 依据 `ollama/docs/api.md`（"Generate a chat completion" 的 message 字段表，2026-10-03 取用）：
   *  - `role` / `content`（必填）；
   *  - `images`（可选）：**base64 列表**（不带 data URL 前缀）；
   *  - `tool_calls`（可选）：`[{ function: { name, arguments } }]`——`arguments` 是**对象**
   *    （与 OpenAI 的 JSON 字符串不同），且**没有 `id` 字段**（Ollama 原生不提供调用 id）；
   *  - `tool_name`（可选）：工具结果消息用它告诉模型「这条结果来自哪个工具」。
   *
   * **为什么 `tool_name` 要靠 id→名映射而不是解析 id 字符串**：本适配器合成的 id 形如
   * `name` / `name#2`，从字符串反解名字会在「工具名本身含 `#`」时解错。这里从同一请求的
   * assistant 消息里取精确对应（`toolCallId` → `name`），不猜。
   *
   * **诚实边界**：`http(s)://` / `file://` 形式的图片无法在不下载的前提下内联为 base64，
   * 故不发送（记 debug 日志并在此成文），而不是编一个 Ollama 不认的字段。
   * @param messages 统一消息列表（事件日志投影的产物）。
   * @returns 可直接放入 `body.messages` 的 wire 消息数组。
   */
  private toOllamaMessages(messages: readonly ModelMessage[]): readonly Record<string, unknown>[] {
    const nameById = LlamaCppModel.toolNamesById(messages);
    return messages.map((message) => {
      const wire: Record<string, unknown> = { role: message.role, content: message.content };
      const images = LlamaCppModel.base64Images(message.images);
      if (images.length > 0) {
        wire['images'] = images;
      }
      if (message.toolCalls !== undefined && message.toolCalls.length > 0) {
        wire['tool_calls'] = message.toolCalls.map((call) => ({
          function: { name: call.name, arguments: call.arguments },
        }));
      }
      if (message.role === 'tool' && message.toolCallId !== undefined) {
        const name = nameById.get(message.toolCallId);
        if (name !== undefined) {
          wire['tool_name'] = name;
        }
      }
      return wire;
    });
  }

  /**
   * 从本请求的 assistant 消息里建「调用 id → 工具名」映射（供工具结果消息填 `tool_name`）。
   * @param messages 统一消息列表。
   * @returns id → 工具名（后出现的同 id 覆盖先前，与「最新一次调用」语义一致）。
   */
  private static toolNamesById(messages: readonly ModelMessage[]): ReadonlyMap<string, string> {
    const out = new Map<string, string>();
    for (const message of messages) {
      for (const call of message.toolCalls ?? []) {
        out.set(call.id, call.name);
      }
    }
    return out;
  }

  /**
   * 取可用于 Ollama `images` 字段的 base64 载荷（剥掉 data URL 前缀）。
   * @param images 统一图像内容（`data` 或 `url` 二选一）。
   * @returns 纯 base64 字符串数组；不可内联的形式（http(s)/file URL、缺载荷）被跳过并记 debug。
   */
  private static base64Images(images: readonly ImageContent[] | undefined): string[] {
    const out: string[] = [];
    for (const image of images ?? []) {
      const inline = LlamaCppModel.inlineBase64(image);
      if (inline !== undefined) {
        out.push(inline);
        continue;
      }
      log.debug('model.ollama.image_skipped', {
        reason: '本地 /api/chat 只接受 base64；http(s)/file URL 需先下载为 base64',
        mediaType: image.mediaType ?? '',
      });
    }
    return out;
  }

  /**
   * 把一个统一图像内容转成纯 base64（含 data URL 解包）。
   * @param image 统一图像内容。
   * @returns 纯 base64；无法在不下载的前提下内联时返回 undefined。
   */
  private static inlineBase64(image: ImageContent): string | undefined {
    const data = image.data;
    if (data !== undefined && data !== '') {
      return data.startsWith('data:') ? (data.split(',')[1] ?? undefined) : data;
    }
    const url = image.url;
    if (url !== undefined && url.startsWith('data:')) {
      return url.split(',')[1];
    }
    return undefined;
  }

  /** 工具转 Ollama 原生格式（与 OpenAI 一致，但参数对象原样下发）。
   * @param tool 统一工具规格。
   * @returns Ollama tools 数组元素（type=function 嵌套结构）。
   */
  private toOllamaTool(tool: ModelToolSpec): unknown {
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    };
  }

  /** 把 Ollama 响应解析为统一输出。
   * @param body wire 层 JSON 响应。
   * @returns 统一模型输出（文本、工具调用与用量）；用量由 prompt_eval_count / eval_count 合成，
   *          两字段皆缺时不含 usage。
   */
  private parseOutput(body: OllamaChatResponse): ModelOutput {
    const output: { text?: string; toolCalls?: ModelToolCallRef[]; usage?: ModelUsage } = {};
    const message = body.message;
    if (message?.content !== undefined && message.content !== '') {
      output.text = message.content;
    }
    if (message?.tool_calls !== undefined && message.tool_calls.length > 0) {
      output.toolCalls = this.toToolCallRefs(message.tool_calls);
    }
    // Ollama 在响应末返回 prompt_eval_count / eval_count（token 用量）。
    if (body.prompt_eval_count !== undefined || body.eval_count !== undefined) {
      const prompt = body.prompt_eval_count ?? 0;
      const completion = body.eval_count ?? 0;
      output.usage = {
        promptTokens: prompt,
        completionTokens: completion,
        totalTokens: prompt + completion,
      };
    }
    return output;
  }

  /** 把 Ollama 工具调用统一为 ModelToolCallRef。
   *
   * `id` 必须**唯一**（配对 `tool_call` / `tool_result` 的键），而 Ollama 原生不返回 id，
   * 故按「函数名 + 第几次同名」合成：首个同名保持裸名（不改单调用场景的既有外观），
   * 后续同名加 `#n` 后缀。旧实现一律用函数名当 id ⇒ 同批两次 `read_file` 的调用与结果
   * 两两不可区分（2026-10-03 与流式合并同一批修复）。
   * @param calls wire 层工具调用集合（arguments 兼容对象与 JSON 字符串两种形态）。
   * @returns 统一工具调用引用数组（id 唯一；字符串参数经解析，非法回退空对象）。
   */
  private toToolCallRefs(calls: readonly OllamaToolCall[]): ModelToolCallRef[] {
    const seen = new Map<string, number>();
    return calls.map((call) => {
      const name = call.function.name;
      const count = seen.get(name) ?? 0;
      seen.set(name, count + 1);
      const args =
        typeof call.function.arguments === 'string'
          ? this.parseArguments(call.function.arguments)
          : call.function.arguments;
      return { id: count === 0 ? name : `${name}#${String(count + 1)}`, name, arguments: args };
    });
  }

  /** 流式工具调用增量合入（**按 index 分桶 + 参数片段累积**，无 index 时回退按函数名合并）。
   *
   * ## 修的是什么（2026-10-03 清偿 PROJECT_BOARD §3-4）
   *
   * 旧实现按**函数名**查找已有条目并**用本片段参数整体覆盖**：
   *  - 同批**同名**并行调用（如两次 `read_file`）被吞并成一条，先到的参数被后者覆盖；
   *  - 参数若被拆成多个片段推送（JSON 字符串分片），每片都单独 `JSON.parse` ⇒ 片片非法、
   *    全部回退 `{}`，调用**带着空参数**发出去（静默错误）。
   *
   * 现按三条规则合入，三者都只做「按协议如实累积」，不发明任何协议语义：
   *  1. **有 `index` 就按 index 分桶**（与 OpenAI 兼容适配器的 `toolBlocks[idx]` 同构）——
   *     index 是服务端给出的调用槽位标识，同名并行调用因此天然分开；
   *  2. **字符串型 arguments 按片段拼接**，仅在**流结束时**解析一次（解析失败仍回退 `{}` 并留痕，
   *     与 `parseArguments` 的既有 fail-soft 口径一致）；对象型 arguments 直接落定（整块到达）；
   *  3. **无 `index`** 时保持按名合并的既有行为（该形态无法区分「续传同一调用」与「另一次同名调用」，
   *     无样本不猜——见下）。
   *
   * ## 诚实边界（为何不在这里做更多）
   *
   * 本机无 ollama 后端，**没有真实流式输出样本**。故：不推断「无 index 的同名第二条究竟是并行调用
   * 还是参数续传」——按仓内纪律「无样本不改协议解析」，该形态保留为按名合并（旧行为）。
   * 已覆盖的是**两种 wire 形态都成立**的改进：分片累积与 index 分桶。
   * @param target 跨片段累积的目标列表（就地修改）。
   * @param calls 当前片段携带的工具调用集合。
   * @returns 无返回值。
   */
  private mergeToolCalls(target: PipelineToolCall[], calls: readonly OllamaToolCall[]): void {
    for (const call of calls) {
      const slot = call.index ?? this.indexOfName(target, call.function.name);
      const existing = target[slot];
      if (existing === undefined) {
        target[slot] = {
          id: this.uniqueId(target, call.function.name),
          name: call.function.name,
          arguments: {},
          ...(typeof call.function.arguments === 'string'
            ? { partial: call.function.arguments }
            : { arguments: call.function.arguments }),
        };
        continue;
      }
      existing.name = call.function.name;
      if (typeof call.function.arguments === 'string') {
        // 分片续传：累积原始文本，流结束时统一解析（逐片解析必然失败）。
        existing.partial = `${existing.partial ?? ''}${call.function.arguments}`;
      } else {
        existing.arguments = call.function.arguments;
      }
    }
  }

  /** 查找同名调用的已有槽位（无 index 时的回退定位）。
   * @param target 已累积的调用列表。
   * @param name 函数名。
   * @returns 首个同名条目下标；无同名条目时返回列表长度（即新槽位）。
   */
  private indexOfName(target: readonly PipelineToolCall[], name: string): number {
    const index = target.findIndex((entry) => entry.name === name);
    return index >= 0 ? index : target.length;
  }

  /** 为一次调用合成**唯一** id（同名并行调用不得共用 id）。
   *
   * 为什么必须唯一：`id` 是 `tool_call` 与 `tool_result` 的配对键（见 `ModelToolCallRef.id`
   * 的契约）。旧实现直接把函数名当 id ⇒ 两次 `read_file` 的调用与结果两两不可区分，
   * 结果为 A 的报文可能被挂到 B 上。Ollama 原生不返回 id，故按「名字」+「第几次同名」合成，
   * 确定性且可读（首个同名保持裸名，不改变单调用场景的既有外观）。
   * @param target 已累积的调用列表（用于计同名次数）。
   * @param name 函数名。
   * @returns 唯一 id。
   */
  private uniqueId(target: readonly PipelineToolCall[], name: string): string {
    const used = target.filter((entry) => entry.name === name).length;
    return used === 0 ? name : `${name}#${String(used + 1)}`;
  }

  /** 收尾：把分片累积的 arguments 解析成形（每个槽位只解析一次）。
   * @param target 已累积的调用列表（就地修改）。
   * @returns 去掉中间态后的统一工具调用数组。
   */
  private finalizeToolCalls(target: readonly PipelineToolCall[]): ModelToolCallRef[] {
    const out: ModelToolCallRef[] = [];
    for (const entry of target) {
      if (entry === undefined) {
        continue;
      }
      const args =
        entry.partial === undefined
          ? entry.arguments
          : this.parseArguments(entry.partial === '' ? '{}' : entry.partial);
      out.push({ id: entry.id, name: entry.name, arguments: args });
    }
    return out;
  }

  /** 解析工具参数 JSON（容错：非法则回退空对象）。
   * @param raw wire 层返回的参数 JSON 字符串。
   * @returns 解析出的参数对象；JSON 非法或不是对象时返回空对象（不抛错）。
   */
  private parseArguments(raw: string): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      // 静默 {} 会让工具带空参数执行且根因不可归因（审计 D5），必须留痕。
      log.warn('model.tool_arguments.invalid_json', {
        raw: raw.slice(0, 200),
        rawLength: raw.length,
      });
      return {};
    }
  }

  /** 从流式片段顶层提取 usage（Ollama 在 done 段返回 prompt_eval_count / eval_count）。
   * @param chunk 当前 NDJSON 片段。
   * @param prev 之前累积的用量，用于缺失字段的回填补齐。
   * @returns 合成后的用量；本片段无任何计数字段时原样返回 prev。
   */
  private usageFromChunk(
    chunk: OllamaChatStreamChunk,
    prev: ModelUsage | undefined,
  ): ModelUsage | undefined {
    if (chunk.prompt_eval_count === undefined && chunk.eval_count === undefined) {
      return prev;
    }
    const prompt = chunk.prompt_eval_count ?? prev?.promptTokens ?? 0;
    const completion = chunk.eval_count ?? prev?.completionTokens ?? 0;
    return { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion };
  }
}

/** Ollama 非流式响应。 */
interface OllamaChatResponse {
  readonly message?: {
    readonly content?: string;
    readonly tool_calls?: readonly OllamaToolCall[];
  };
  readonly prompt_eval_count?: number;
  readonly eval_count?: number;
}

/** Ollama 流式片段（usage 在 done 段以顶层字段返回）。 */
interface OllamaChatStreamChunk {
  readonly message?: {
    content?: string;
    tool_calls?: readonly OllamaToolCall[];
  };
  readonly done?: boolean;
  readonly prompt_eval_count?: number;
  readonly eval_count?: number;
}

/** 流式累积中的工具调用槽位（`partial` 为尚未解析的参数片段，见 `mergeToolCalls`）。 */
interface PipelineToolCall {
  /** 合成 id（唯一；配对 `tool_call` 与 `tool_result`）。 */
  id: string;
  /** 函数名。 */
  name: string;
  /** 已成形的参数（对象型 arguments 直接落定；用 `partial` 时为初始空对象）。 */
  arguments: Record<string, unknown>;
  /** 分片累积的原始参数文本；流结束时只解析一次。 */
  partial?: string | undefined;
}

/** Ollama 工具调用（arguments 可为对象或 JSON 字符串，两种都兼容）。 */
interface OllamaToolCall {
  /**
   * 调用槽位下标（部分实现返回；Ollama 原生旧版本不返回 ⇒ 可选）。
   * 给了就按它分桶，使**同名并行调用**不再互相覆盖。
   */
  readonly index?: number | undefined;
  readonly function: {
    readonly name: string;
    readonly arguments: Record<string, unknown> | string;
  };
}
