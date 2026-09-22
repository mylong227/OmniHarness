import type {
  ContextCategoryKey,
  ModelContextSnapshot,
  ModelMessage,
} from '../ports/model/model.js';
import type { ToolDefinition } from '../ports/tool/tool.js';
import { TokenEstimator } from './tokenEstimator.js';

/**
 * 分类键与快照类型定义在 `ports/model.ts`（模型域词汇，事件快照与 UI 协议共用），
 * 此处再导出，使上下文域的调用点只需 import 本模块。
 */
export type { ContextCategoryKey, ModelContextSnapshot } from '../ports/model/model.js';

/** 分类元数据（键 → 展示名）。 */
export interface ContextCategoryMeta {
  readonly key: ContextCategoryKey;
  readonly label: string;
}

/** 分类展示顺序与名称（单一来源：UI 不再自造中文名，避免两处漂移）。 */
export const CONTEXT_CATEGORIES: readonly ContextCategoryMeta[] = [
  { key: 'messages', label: '消息' },
  { key: 'mcpTools', label: 'MCP 工具' },
  { key: 'systemTools', label: '系统工具' },
  { key: 'systemPrompt', label: '系统提示词' },
  { key: 'skills', label: '技能' },
  { key: 'other', label: '其他' },
];

/**
 * MCP 工具的命名分隔符。
 * 与 `McpGateway.prefixedName`（`server__tool`）严格一致——两处若漂移，
 * 本分类器会把 MCP 工具误记成「系统工具」，面板口径失真。
 */
const MCP_NAME_SEPARATOR = '__';

/** 技能注入片段的前缀（与 `SkillRegistry.render` 的首行严格一致）。 */
const SKILL_MARKER = '# 技能：';

/** 每条消息的角色/协议固定开销（与 `TokenEstimator.estimateMessages` 的 +4 保持同口径）。 */
const MESSAGE_OVERHEAD_TOKENS = 4;

/** 单行分类占比。 */
export interface ContextBreakdownRow {
  /** 分类键。 */
  readonly key: ContextCategoryKey;
  /** 分类展示名（取自 CONTEXT_CATEGORIES）。 */
  readonly label: string;
  /** 该类估算 token 数。 */
  readonly tokens: number;
  /** 占**已用上下文**的百分比（0–100，一位小数）。与窗口占比是两回事：本字段各行之和不含余量。 */
  readonly percent: number;
}

/** 估算输入。 */
export interface ContextBreakdownInput {
  /** 已组装的模型消息（真实送出或从事件日志投影所得）。 */
  readonly messages: readonly ModelMessage[];
  /** 本轮可见的工具定义（直载 ∪ 已发现）。 */
  readonly tools: readonly ToolDefinition[];
  /** messages 前 N 条 system 属基础常驻片段（系统提示词），其余 system 归「其他」或「技能」。 */
  readonly baseFragmentCount: number;
  /** 上下文窗口总 token 数（denominator 用）。 */
  readonly windowTokens: number;
}

/** 估算结果。 */
export interface ContextBreakdown {
  /** 上下文窗口 token 数。 */
  readonly windowTokens: number;
  /** 已用 token 数（各行之和）。 */
  readonly usedTokens: number;
  /** 已用占窗口百分比（0–100，一位小数）。 */
  readonly percent: number;
  /** 分类明细（按 CONTEXT_CATEGORIES 顺序，含 0 值行）。 */
  readonly rows: readonly ContextBreakdownRow[];
  /** MCP 工具条数（诊断用）。 */
  readonly mcpToolCount: number;
  /** 系统工具条数（诊断用）。 */
  readonly systemToolCount: number;
}

/**
 * 上下文容量分解器。
 *
 * 输入是「已经组装好的消息 + 本轮可见工具」——与真实请求同源，因此既能用于
 * 取值时重算（从事件日志投影），也能用于**实测**（`StepRunner` 在发出请求的同一位置快照）。
 * 本类不读事件日志、不碰 IO，纯函数式判别，便于在 node 环境直接单测。
 *
 * 口径与已知边界：
 *  - 六类互斥且穷尽：每条消息 / 每个工具定义必落且仅落一类；
 *  - 图片与音视频附件的**二进制载荷不计入**（其 token 数取决于厂商视觉编码器，
 *    无法从 base64 长度推断；按长度折算会严重高估），只计文本与工具调用参数 JSON；
 *  - 一切数值都是估算：CJK 按字计、其余按 4 字符/token（沿用 {@link TokenEstimator}）。
 */
export class ContextBreakdownEstimator {
  private readonly estimator: TokenEstimator;
  /**
   * 工具定义 → token 数缓存（按对象引用）。
   *
   * 为什么：`estimate` 每步都跑（`stepRunner` 的上下文快照），而工具定义在会话内是静态的；
   * 原实现对 33 个工具**每步**重新 `JSON.stringify`（schema 可能上千字符）。实测该步在
   * 170 KB / 850 KB / 2.55 MB 上下文下分别占 2.53 / 11.30 / 34.41 ms，其中相当部分是重复序列化。
   * 用 WeakMap 而非 Map：注册表换定义（热卸载/重载）后旧条目可被回收，不构成泄漏。
   */
  private readonly toolTokenCache = new WeakMap<ToolDefinition, number>();

  /**
   * @param estimator token 估算器（缺省新建；注入便于单测固定口径）
   */
  public constructor(estimator: TokenEstimator = new TokenEstimator()) {
    this.estimator = estimator;
  }

  /**
   * 分解上下文占用。
   * @param input 消息、工具、基础片段条数与窗口大小
   * @returns 六类明细 + 汇总（含 0 值行，保证 UI 行序稳定不跳动）
   */
  public estimate(input: ContextBreakdownInput): ContextBreakdown {
    const totals = new Map<ContextCategoryKey, number>();
    for (const meta of CONTEXT_CATEGORIES) {
      totals.set(meta.key, 0);
    }
    for (let i = 0; i < input.messages.length; i += 1) {
      const message = input.messages[i];
      if (message === undefined) continue;
      const key = this.classifyMessage(message, i < input.baseFragmentCount);
      this.add(totals, key, this.messageTokens(message));
    }
    let mcpToolCount = 0;
    let systemToolCount = 0;
    for (const tool of input.tools) {
      const isMcp = tool.name.includes(MCP_NAME_SEPARATOR);
      if (isMcp) mcpToolCount += 1;
      else systemToolCount += 1;
      this.add(totals, isMcp ? 'mcpTools' : 'systemTools', this.toolTokens(tool));
    }
    const used = ContextBreakdownEstimator.sum(totals.values());
    const rows: ContextBreakdownRow[] = CONTEXT_CATEGORIES.map((meta) => {
      const tokens = totals.get(meta.key) ?? 0;
      return {
        key: meta.key,
        label: meta.label,
        tokens,
        percent: ContextBreakdownEstimator.ratio(tokens, used),
      };
    });
    return {
      windowTokens: input.windowTokens,
      usedTokens: used,
      percent: ContextBreakdownEstimator.ratio(used, input.windowTokens),
      rows,
      mcpToolCount,
      systemToolCount,
    };
  }

  /**
   * 把分解结果压成事件日志里的紧凑快照。
   * @param breakdown 分解结果
   * @returns 只含 token 数、计数与窗口的快照
   */
  public snapshotOf(breakdown: ContextBreakdown): ModelContextSnapshot {
    const tokens = {} as Record<ContextCategoryKey, number>;
    for (const row of breakdown.rows) {
      tokens[row.key] = row.tokens;
    }
    return {
      windowTokens: breakdown.windowTokens,
      usedTokens: breakdown.usedTokens,
      mcpToolCount: breakdown.mcpToolCount,
      systemToolCount: breakdown.systemToolCount,
      tokens,
    };
  }

  /**
   * 由快照重建分解结果（百分比按当前口径重算，不读历史百分比）。
   * @param snapshot 事件日志中的快照
   * @returns 与 `estimate` 同形的分解结果
   */
  public breakdownOf(snapshot: ModelContextSnapshot): ContextBreakdown {
    const rows: ContextBreakdownRow[] = CONTEXT_CATEGORIES.map((meta) => {
      const tokens = snapshot.tokens[meta.key] ?? 0;
      return {
        key: meta.key,
        label: meta.label,
        tokens,
        percent: ContextBreakdownEstimator.ratio(tokens, snapshot.usedTokens),
      };
    });
    return {
      windowTokens: snapshot.windowTokens,
      usedTokens: snapshot.usedTokens,
      percent: ContextBreakdownEstimator.ratio(snapshot.usedTokens, snapshot.windowTokens),
      rows,
      mcpToolCount: snapshot.mcpToolCount,
      systemToolCount: snapshot.systemToolCount,
    };
  }

  /**
   * 单条消息归类：系统片段按前缀分流，其余按角色归「消息」。
   * @param message 模型消息
   * @param isBaseFragment 是否属基础常驻片段（由调用方按下标判定）
   * @returns 该消息所属分类键
   */
  private classifyMessage(message: ModelMessage, isBaseFragment: boolean): ContextCategoryKey {
    if (message.role !== 'system') return 'messages';
    if (isBaseFragment) return 'systemPrompt';
    return message.content.startsWith(SKILL_MARKER) ? 'skills' : 'other';
  }

  /** 单条消息的 token 估算：正文 + 工具调用参数 JSON + 每条固定开销（附件二进制不计）。 */
  private messageTokens(message: ModelMessage): number {
    let tokens = this.estimator.estimate(message.content) + MESSAGE_OVERHEAD_TOKENS;
    const calls = message.toolCalls;
    if (calls !== undefined && calls.length > 0) {
      tokens += this.estimator.estimate(JSON.stringify(calls));
    }
    return tokens;
  }

  /** 单个工具定义的 token 估算：按真实发给模型的序列化形态（name + description + JSON Schema）计。
   * 结果按定义对象缓存（见 {@link ContextBreakdownEstimator.toolTokenCache}）。
   * @param tool 工具定义
   * @returns 该定义的 token 估算值
   */
  private toolTokens(tool: ToolDefinition): number {
    const cached = this.toolTokenCache.get(tool);
    if (cached !== undefined) {
      return cached;
    }
    const tokens = this.estimator.estimate(
      JSON.stringify({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }),
    );
    this.toolTokenCache.set(tool, tokens);
    return tokens;
  }

  /** 累加某分类的 token 数（分类键必已初始化）。
   * @returns 无返回值。
   */
  private add(
    totals: Map<ContextCategoryKey, number>,
    key: ContextCategoryKey,
    tokens: number,
  ): void {
    totals.set(key, (totals.get(key) ?? 0) + tokens);
  }
  /**
   * sum (internal helper hoisted into ContextBreakdownEstimator).
   * @param {Iterable<number>} values
   * @returns {number}
   */
  private static sum(values: Iterable<number>): number {
    let total = 0;
    for (const value of values) total += value;
    return total;
  }
  /**
   * ratio (internal helper hoisted into ContextBreakdownEstimator).
   * @param {number} part
   * @param {number} whole
   * @returns {number}
   */
  private static ratio(part: number, whole: number): number {
    if (!Number.isFinite(whole) || whole <= 0) return 0;
    return Math.round((part / whole) * 1000) / 10;
  }
}

/** 求和（空集合为 0）。 */

/** 百分比（一位小数）；分母为 0 时返回 0，避免 NaN 渗进 UI。 */
