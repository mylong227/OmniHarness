/**
 * 插话相关性判定（2026-10-31，聊天「插话模式」）。
 *
 * ## 要解决的问题
 *
 * 任务执行中用户再发一条消息，有两种完全不同的意图：
 * 1. **补充 / 纠正 / 追问**（"不对，应该先跑测试"）——应当并入当前任务的上下文继续做；
 * 2. **打断 / 换任务**（"算了，改做登录页"）——应当立即结束当前回合，转入新任务。
 *
 * 两者在 UI 上都只是「Enter」，所以必须有一个**可解释、可单测**的判定器来做分流。
 * 这里只做纯文本启发式（零模型调用、零 IO、毫秒级）：模型分类要额外一次请求，
 * 会让「插话」变成秒级等待，且成本不可控。判定结果带 `reason`，UI 可如实告诉用户
 * 为什么被打断（而不是黑箱）。
 *
 * ## 判定顺序（先强后弱，避免互相打架）
 *
 * 1. 空文本 ⇒ 视为附件补充（调用方已保证至少带附件）；
 * 2. 打断词命中 ⇒ 无关（最高优先级：用户明确说"停了/换个任务"）；
 * 3. 强关联词命中 ⇒ 相关（"继续/补充/不对/改成…"）；
 * 4. 短确认 ⇒ 相关（"好的/继续/ok" 这类没有独立任务的短句）；
 * 5. 词面重合 ⇒ 相关（与最近对话共享非停用词，说明在同一话题上）；
 * 6. 其余 ⇒ 无关（真正的新话题，交给调用方中断当前回合）。
 */
import type { SessionEvent } from '../../ports/runtime/event/sessionEvent.ts';

/** 判定依据（透传给 UI / 日志，便于解释"为什么被打断"）。 */
export type InterjectionReason =
  | 'attachment-only'
  | 'interrupt-marker'
  | 'related-marker'
  | 'acknowledgement'
  | 'lexical-overlap'
  | 'new-topic';

/** 一次插话判定结果。 */
export interface InterjectionDecision {
  /** 是否与当前任务相关（true=并入当前任务；false=中断并开启新任务）。 */
  readonly related: boolean;
  /** 判定依据。 */
  readonly reason: InterjectionReason;
  /** 词面重合度（0–1；无重合为 0，仅用于观测与解释）。 */
  readonly score: number;
}

/** 明确表达「停止当前 / 换个任务」的词（命中即无关，优先级最高）。 */
const INTERRUPT_MARKERS: readonly string[] = [
  '算了',
  '不用了',
  '别做了',
  '不做了',
  '停止',
  '停一下',
  '先停',
  '终止当前',
  '取消当前',
  '取消刚才',
  '打断',
  '换个任务',
  '换一个任务',
  '换个话题',
  '换一个话题',
  '另一件事',
  '另一个任务',
  '另一个需求',
  '新任务',
  '新需求',
  '重新开始',
  '从头开始',
  '清空重来',
  '改做别的',
  '改成别的任务',
  '别管这个',
  '放弃当前',
];

/** 明确指向「同一任务」的关联词（命中即相关）。 */
const RELATED_MARKERS: readonly string[] = [
  '继续',
  '接着',
  '补充',
  '另外',
  '顺便',
  '同时',
  '不对',
  '纠正',
  '修正',
  '改成',
  '改为',
  '换成',
  '替换',
  '应该是',
  '刚才',
  '上面',
  '前面',
  '再加上',
  '别忘了',
  '记得',
  '还要',
  '再补',
  '调整',
  '优化',
  '修复',
  '完善',
  '补上',
  '没生效',
  '有问题',
  '报错',
];

/** 短确认句（没有独立任务，视为对上一轮的回应）。 */
const ACK_PATTERN =
  /^(好的?|好滴|可以|行|嗯+|对|是的?|继续|接着|ok|okay|yes|no|谢谢|收到|明白|知道了|没问题)[。.!！?？\s]*$/i;

/**
 * 词面重合的停用词（中文双字切分后常见的高频虚词组合）。
 *
 * 不剔除它们时，「帮我查一下…」与「帮我改一下…」会因为「帮我/一下」被误判成同一话题
 * ——这正是最贵的误判：无关任务被当成补充，用户在等一个永远不开始的新任务。
 */
const STOP_TOKENS: ReadonlySet<string> = new Set<string>([
  '帮我',
  '一个',
  '一下',
  '我们',
  '你们',
  '他们',
  '可以',
  '什么',
  '怎么',
  '这个',
  '那个',
  '现在',
  '已经',
  '然后',
  '就是',
  '还是',
  '没有',
  '不是',
  '你好',
  '谢谢',
  '需要',
  '想要',
  '不能',
  '是否',
  '这里',
  '那里',
  '时候',
  '开始',
  '进行',
  '完成',
  '麻烦',
  '请帮',
  '给我',
  '能不',
]);

/** 上下文最多取几条消息（越多越容易误命中，取最近对话足够判断话题）。 */
const CONTEXT_MESSAGES = 12;
/** 单条消息截断长度（避免长回答把词表撑爆；话题判断只看开头足够）。 */
const CONTEXT_CHARS = 2000;
/** 词面重合比例阈值：新文本非停用词里至少这么多比例出现在最近对话中才算相关。 */
const OVERLAP_RATIO = 0.15;

/** 插话相关性判定器（纯函数，零状态）。 */
export class InterjectionClassifier {
  /**
   * 从会话事件里取最近若干条对话文本（user / assistant 的 content）。
   *
   * 只取 `content` 字符串：图片/文件附件本身不参与文本相似度（它们已由调用方直接
   * 作为附件并入），工具调用与系统提示也不该算"用户话题"。
   * @param events 事件流（按时间正序）
   * @param limit 最多取几条（默认 12）
   * @returns 最近的对话文本（按时间正序；已截断单条长度）
   */
  public static contextOf(events: readonly SessionEvent[], limit = CONTEXT_MESSAGES): string[] {
    const out: string[] = [];
    for (let i = events.length - 1; i >= 0 && out.length < limit; i -= 1) {
      const event = events[i];
      if (event === undefined) continue;
      if (event.type !== 'user' && event.type !== 'assistant') continue;
      const content = InterjectionClassifier.contentOf(event.payload);
      if (content === '') continue;
      out.push(content.length > CONTEXT_CHARS ? content.slice(0, CONTEXT_CHARS) : content);
    }
    return out.reverse();
  }

  /**
   * 判定一条新消息与当前任务是否相关。
   * @param text 新消息文本（空串表示纯附件补充）
   * @param context 最近对话文本（{@link InterjectionClassifier.contextOf}）
   * @returns 判定结果（related / reason / score）
   */
  public static classify(text: string, context: readonly string[]): InterjectionDecision {
    const trimmed = text.trim();
    if (trimmed === '') {
      return { related: true, reason: 'attachment-only', score: 0 };
    }
    const lower = trimmed.toLowerCase();
    if (INTERRUPT_MARKERS.some((marker) => lower.includes(marker))) {
      return { related: false, reason: 'interrupt-marker', score: 0 };
    }
    if (RELATED_MARKERS.some((marker) => lower.includes(marker))) {
      return { related: true, reason: 'related-marker', score: 0 };
    }
    if (ACK_PATTERN.test(trimmed)) {
      return { related: true, reason: 'acknowledgement', score: 0 };
    }
    const mine = InterjectionClassifier.tokensOf(trimmed);
    if (mine.size === 0) {
      // 全是标点/停用词：没有可判断的话题信息，按"相关"处理（宁可并入，不误杀在跑任务）。
      return { related: true, reason: 'acknowledgement', score: 0 };
    }
    const theirs = new Set<string>();
    for (const message of context) {
      for (const token of InterjectionClassifier.tokensOf(message)) theirs.add(token);
    }
    let hit = 0;
    for (const token of mine) if (theirs.has(token)) hit += 1;
    const score = hit / mine.size;
    if (hit > 0 && score >= OVERLAP_RATIO) {
      return { related: true, reason: 'lexical-overlap', score };
    }
    return { related: false, reason: 'new-topic', score };
  }

  /**
   * 取事件 payload 的 content 文本（非字符串 / 缺失一律空串，绝不猜）。
   * @param payload 事件载荷
   * @returns 文本
   */
  private static contentOf(payload: unknown): string {
    if (payload === null || typeof payload !== 'object') return '';
    const content = (payload as { content?: unknown }).content;
    return typeof content === 'string' ? content.trim() : '';
  }

  /**
   * 把文本切成「中文双字 + 英文词」词元集合（停用词已剔除）。
   *
   * 中文用双字切分而不是分词器：零依赖、对中英混排稳，且双字足以表达话题重合
   * （"测试/设置/接口"这类双字词命中率最高）。
   * @param text 原始文本
   * @returns 词元集合（带前缀区分中文双字与英文词）
   */
  private static tokensOf(text: string): Set<string> {
    const out = new Set<string>();
    const lower = text.toLowerCase();
    for (const word of lower.match(/[a-z0-9_./-]{2,}/g) ?? []) {
      if (!STOP_TOKENS.has(word)) out.add('w:' + word);
    }
    const cjk = lower.replace(/[^\u4e00-\u9fff]+/g, ' ');
    for (const segment of cjk.split(/\s+/)) {
      for (let i = 0; i + 1 < segment.length; i += 1) {
        const bigram = segment.slice(i, i + 2);
        if (!STOP_TOKENS.has(bigram)) out.add('c:' + bigram);
      }
    }
    return out;
  }
}
