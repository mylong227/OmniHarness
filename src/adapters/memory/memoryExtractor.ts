import { randomUUID } from 'node:crypto';
import type { LongTermMemoryPort, MemoryFact } from '../../ports/longTermMemory.js';
import type { ModelPort, ModelRequest } from '../../ports/model.js';
import type { SessionEvent } from '../../ports/event.js';

/**
 * @beta
 * 蒸馏选项。
 */
export interface MemoryExtractorOptions {
  /** 每回合最多沉淀事实数（默认 8）。 */
  readonly maxFactsPerTurn?: number;
  /** 单回合文本上限（字符，默认 6000），超出截断避免喂爆上下文。 */
  readonly maxTranscriptChars?: number;
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
export class MemoryExtractor {
  public readonly name = 'memory-extractor';

  /** 已蒸馏事件数（游标），避免跨回合重复。 */
  private cursor = 0;

  public constructor(
    private readonly model: ModelPort,
    private readonly store: LongTermMemoryPort,
    private readonly opts: MemoryExtractorOptions = {},
  ) {}

  /**
   * 回合末调用：把自上次蒸馏以来的新事件蒸馏为持久事实并沉淀。
   * 通过内部游标 `cursor` 仅处理增量事件，避免每回合重复蒸馏整段历史。
   * @returns 本次新增事实数。
   */
  public async consolidate(events: readonly SessionEvent[], sessionId: string): Promise<number> {
    const fresh = events.slice(this.cursor);
    if (fresh.length === 0) {
      this.cursor = events.length;
      return 0;
    }
    const transcript = transcriptOf(fresh, this.opts.maxTranscriptChars ?? 6000);
    let added = 0;
    if (transcript.length > 0) {
      const extracted = await this.extract(transcript);
      const max = this.opts.maxFactsPerTurn ?? 8;
      const existing = new Set(this.store.all().map((fact) => normalize(fact.text)));
      for (const text of extracted) {
        if (added >= max) {
          break;
        }
        const norm = normalize(text);
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
        };
        this.store.remember(fact);
        existing.add(norm);
        added += 1;
      }
    }
    this.cursor = events.length;
    return added;
  }

  /** 阶段一：LLM 从回合文本抽取可跨会话复用的持久事实。 */
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
    return parseFacts(output.text ?? '');
  }
}

/** 从事件抽取可蒸馏文本（user/assistant/tool_result），拼接为回合片段。 */
function transcriptOf(events: readonly SessionEvent[], limit: number): string {
  const lines: string[] = [];
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
        text = typeof payload['content'] === 'string' ? (payload['content'] as string) : undefined;
        break;
      case 'tool_result':
        text = typeof payload['output'] === 'string' ? (payload['output'] as string) : undefined;
        break;
      default:
        break;
    }
    if (text !== undefined && text.trim() !== '') {
      lines.push(text);
    }
  }
  const joined = lines.join('\n');
  return joined.length <= limit ? joined : joined.slice(0, limit);
}

/** 解析模型返回的 JSON 事实数组，鲁棒处理前缀/后缀废话。 */
function parseFacts(text: string): string[] {
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

/** 归一化事实文本用于去重（小写、去标点、折叠空白）。 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
