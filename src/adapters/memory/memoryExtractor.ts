import { randomUUID } from 'node:crypto';
import type { LongTermMemoryPort, MemoryFact } from '../../ports/memory/longTermMemory.js';
import type { ModelPort, ModelRequest } from '../../ports/model/model.js';
import type { SessionEvent } from '../../ports/runtime/event.js';
import type { MemoryExtractorPort } from '../../ports/memory/memoryExtractor.js';

/**
 * @beta
 * 蒸馏选项。
 */
export interface MemoryExtractorOptions {
  /** 每回合最多沉淀事实数（默认 8）。 */
  readonly maxFactsPerTurn?: number | undefined;
  /** 单回合文本上限（字符，默认 6000），超出截断避免喂爆上下文。 */
  readonly maxTranscriptChars?: number | undefined;
  /**
   * 是否把 `tool_result` 输出并入蒸馏文本（**默认 false ＝ 排除**，G9/M3 投毒闸）。
   *
   * ## 为什么默认排除（这不是保守，是修一条已确证的投毒链）
   *
   * `tool_result` 是**不可信内容**的天然载体（网页抓取、第三方命令输出、被读文件的内容都可能带
   * 指使性文本），而抽取提示**明确要求**记住"环境事实、踩过的坑"——那正是指令文本的最佳伪装位。
   * 一旦入库，`sessionInjector` 会以 **system 身份**把它回灌进后续每个会话。
   *
   * ⇒ 默认**不把工具输出喂给抽取器**：工具输出里的指令连"被蒸馏"的机会都没有。
   * 开启后（显式 opt-in）该回合抽出的事实被标 `trust: 'untrusted'`，回灌时带来源警示。
   */
  readonly includeToolOutput?: boolean | undefined;
}

/**
 * @beta
 * 长期记忆蒸馏器（#S28，对标 codex memories 两阶段 LLM）：
 * 把回合事件（用户/助手/工具输出）蒸馏为可跨会话复用的持久事实，沉淀进长期记忆。
 *
 * - 阶段一（LLM 抽取）：用模型从回合文本抽取 salient 事实（用户偏好/约定/决策/坑）。
 * - 阶段二（确定性合并）：与既有事实做归一化去重，避免重复沉淀；不调用模型，低成本。
 *
 * 由 `TurnRunner` 在回合末注入式调用（config 统一装配，不 new 在循环内），
 * 通过内部游标避免每回合重复蒸馏同一段历史。
 */
export class MemoryExtractor implements MemoryExtractorPort {
  /** 适配器标识：用于端口注册与诊断日志归组（固定值 'memory-extractor'）。 */
  public readonly name = 'memory-extractor';

  /** 已蒸馏事件数（游标），避免跨回合重复。 */
  private cursor = 0;

  /**
   * @param model 用于阶段一抽取的模型端口。
   * @param store 沉淀目标：长期记忆端口（去重与写入均经它）。
   * @param opts 蒸馏选项（每回合上限与文本截断，全有默认）。
   */
  public constructor(
    private readonly model: ModelPort,
    private readonly store: LongTermMemoryPort,
    private readonly opts: MemoryExtractorOptions = {},
  ) {}

  /**
   * 回合末调用：把自上次蒸馏以来的新事件蒸馏为持久事实并沉淀。
   * 通过内部游标 `cursor` 仅处理增量事件，避免每回合重复蒸馏整段历史。
   * @param events 会话事件全量序列（内部按游标取增量）。
   * @param sessionId 沉淀事实归属的会话 id。
   * @returns 本次新增事实数。
   */
  public async consolidate(events: readonly SessionEvent[], sessionId: string): Promise<number> {
    const fresh = events.slice(this.cursor);
    if (fresh.length === 0) {
      this.cursor = events.length;
      return 0;
    }
    const includeToolOutput = this.opts.includeToolOutput === true;
    const transcript = MemoryExtractor.transcriptOf(
      fresh,
      this.opts.maxTranscriptChars ?? 6000,
      includeToolOutput,
    );
    let added = 0;
    if (transcript.length > 0) {
      const extracted = await this.extract(transcript);
      const max = this.opts.maxFactsPerTurn ?? 8;
      const existing = new Set(
        this.store.all().map((fact) => MemoryExtractor.normalize(fact.text)),
      );
      for (const text of extracted) {
        if (added >= max) {
          break;
        }
        const norm = MemoryExtractor.normalize(text);
        if (norm === '' || existing.has(norm)) {
          continue;
        }
        const fact: MemoryFact = {
          id: randomUUID(),
          text,
          importance: 3,
          createdAt: new Date().toISOString(),
          sessionId,
          source: 'consolidated',
          // 只有"显式把工具输出喂进抽取器"的回合才可能被工具输出里的文本左右 ⇒ 标为未验证。
          // 默认档（排除工具输出）下不设该字段：事实只源自 user/assistant 文本。
          ...(includeToolOutput ? { trust: 'untrusted' as const } : {}),
        };
        this.store.remember(fact);
        existing.add(norm);
        added += 1;
      }
    }
    this.cursor = events.length;
    return added;
  }

  /** 阶段一：LLM 从回合文本抽取可跨会话复用的持久事实。
   * @param transcript 已截断的回合对话片段。
   * @returns 抽取出的简短事实字符串数组（解析失败为空数组）。
   */
  private async extract(transcript: string): Promise<string[]> {
    const prompt =
      '你是从对话中抽取"长期记忆"的抽取器。下面是某个回合的对话片段（用户/助手/工具输出）。' +
      '请抽取其中值得跨会话长期保留的事实性信息——用户偏好、项目约定、关键决策、环境事实、踩过的坑、对用户的承诺等。' +
      '忽略一次性闲聊、临时输出、可被重新检索的琐碎内容。只输出一个 JSON 数组，元素为简短事实字符串，不要任何其他文字。\n\n' +
      `对话片段：\n${transcript}`;
    const request: ModelRequest = {
      messages: [{ role: 'user', content: prompt }],
      tools: [],
    };
    const output = await this.model.generate(request);
    return MemoryExtractor.parseFacts(output.text ?? '');
  }

  /**
   * 从事件抽取可蒸馏文本（user/assistant/system；`tool_result` 见下），拼接为回合片段。
   *
   * ## 投毒闸（G9/M3，2026-10-03 第十四轮）
   *
   * `tool_result` 是**不可信内容**的天然载体（网页/第三方命令输出/被读文件都可能带指使性文本），
   * 而抽取提示恰恰要求记住"环境事实、踩过的坑"——那是指令文本的最佳伪装位。故**默认不并入**；
   * 并且即使不并入，也在片段里**显式标注"已按信任策略省略"**，避免抽取器凭空脑补被省略的内容。
   *
   * @param events 会话事件序列。
   * @param limit 文本字符上限（超出截断）。
   * @param includeToolOutput 是否并入 `tool_result` 输出（默认 false；显式 opt-in 才为 true）。
   * @returns 拼接后的回合文本（已截断）。
   */
  private static transcriptOf(
    events: readonly SessionEvent[],
    limit: number,
    includeToolOutput = false,
  ): string {
    const lines: string[] = [];
    let omittedToolResults = 0;
    for (const event of events) {
      const payload = event.payload as Record<string, unknown> | undefined;
      if (payload === undefined) {
        continue;
      }
      let text: string | undefined;
      switch (event.type) {
        case 'user':
        case 'assistant':
        case 'system':
          text =
            typeof payload['content'] === 'string' ? (payload['content'] as string) : undefined;
          break;
        case 'tool_result':
          if (!includeToolOutput) {
            omittedToolResults += 1;
            break;
          }
          text = typeof payload['output'] === 'string' ? (payload['output'] as string) : undefined;
          break;
        default:
          break;
      }
      if (text !== undefined && text.trim() !== '') {
        lines.push(text);
      }
    }
    // 省略说明只在**确有可蒸馏内容**时附上：若本回合只有工具输出（没有任何 user/assistant 文本），
    // 那就**根本不该抽调取器**——"没有可信内容可蒸馏"不等于"有一段说明文字可以蒸馏"
    //（2026-10-03 实测：首版无条件附说明 ⇒ 只含工具输出的回合也产出了事实）。
    if (omittedToolResults > 0 && lines.length > 0) {
      lines.push(
        `（本回合有 ${String(omittedToolResults)} 条工具输出已按信任策略省略：工具输出不可信，不作为记忆来源）`,
      );
    }
    const joined = lines.join('\n');
    return joined.length <= limit ? joined : joined.slice(0, limit);
  }

  /**
   * 解析模型返回的 JSON 事实数组，鲁棒处理前缀/后缀废话。
   * @param text 模型原始输出
   * @returns 抽取出的事实字符串数组（解析失败为空数组）
   */
  private static parseFacts(text: string): string[] {
    const trimmed = text.trim();
    if (trimmed === '') {
      return [];
    }
    const start = trimmed.indexOf('[');
    const end = trimmed.lastIndexOf(']');
    if (start === -1 || end === -1 || end <= start) {
      return [];
    }
    try {
      const arr = JSON.parse(trimmed.slice(start, end + 1));
      if (!Array.isArray(arr)) {
        return [];
      }
      return arr
        .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
        .map((item) => item.trim());
    } catch {
      return [];
    }
  }

  /**
   * 归一化事实文本用于去重（小写、去标点、折叠空白）。
   * @param text 原始事实文本
   * @returns 归一化后的文本（用于去重比较）
   */
  private static normalize(text: string): string {
    return text
      .toLowerCase()
      .replace(/[\p{P}\p{S}]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
}
