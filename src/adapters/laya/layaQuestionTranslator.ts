/**
 * Laya 桥协议（TS 侧）：线格式类型 + 端口问题 → Laya 线格式的翻译。
 *
 * 与 `laya_infer.py` 的协议一一对应（两种运行模式同一份语义）：
 * 单发 `--request-file`（一个请求一个响应）与常驻 `--serve`（JSONL，一次加载多次前向）。
 *
 * 翻译是**六边形适配器的本职**：端口用第三方-free 的 `kind`，Laya 线格式用 `type`；
 * 两边各自演化时只改这里，不动端口、也不动调用方。
 */
import type { DecisionAnswer, DecisionQuestion } from '../../ports/decision/decisionEngine.js';

/** Laya 线格式问题（`type` 而非端口的 `kind`；criteria 形状随 type 变化）。 */
export type LayaWireQuestion = Readonly<Record<string, unknown>>;

/** 桥响应（单发与常驻同一份形状；`id` 仅常驻模式回带，`ms` 为桥内耗时）。 */
export interface LayaBridgeResponse {
  /** 各题答案（端口契约形状）。 */
  readonly answers?: Readonly<Record<string, DecisionAnswer>>;
  /** 实际使用的模型 / checkpoint 标识（本地为权重目录，在线为 checkpoint 名）。 */
  readonly model?: string;
  /** 后端是否可用。 */
  readonly available?: boolean;
  /** 不可用 / 退化原因。 */
  readonly note?: string;
  /** 桥内推理耗时（毫秒；`warmup` 帧为加载耗时）。 */
  readonly ms?: number;
  /** 常驻模式的请求回带 id。 */
  readonly id?: number;
  /** 该帧是对 `warmup` 请求的应答（权重已加载）。 */
  readonly warmup?: boolean;
}

/**
 * 端口问题 → Laya 线格式翻译器（无状态）。
 *
 * 映射规则（与 `laya_infer.py` 的请求说明对齐）：
 * - `noul`   → `{ type: "noul", instructions }`
 * - `choice` → `{ type: "choice", instructions, criteria: { 类别: null } }`（Laya 的 choice 只要键）
 * - `score`  → `{ type: "score", instructions, criteria: string[] }`（Laya 的 score 要有序等级）
 */
export class LayaQuestionTranslator {
  /**
   * 翻译单题。
   *
   * @param question 端口问题定义。
   * @returns Laya `predict` / `system_one` 接受的 question dict。
   */
  public static toWireQuestion(question: DecisionQuestion): LayaWireQuestion {
    const base = { instructions: question.instructions };
    switch (question.kind) {
      case 'noul':
        return { type: 'noul', ...base };
      case 'choice':
        return {
          type: 'choice',
          ...base,
          criteria: LayaQuestionTranslator.choiceCriteria(question),
        };
      case 'score':
        return { type: 'score', ...base, criteria: LayaQuestionTranslator.scoreCriteria(question) };
    }
  }

  /**
   * 翻译整组问题（保持问题名对齐）。
   *
   * @param questions 端口问题集（键为问题名）。
   * @returns Laya question dict 集。
   */
  public static toWireQuestions(
    questions: Readonly<Record<string, DecisionQuestion>>,
  ): Record<string, LayaWireQuestion> {
    const out: Record<string, LayaWireQuestion> = {};
    for (const [name, question] of Object.entries(questions)) {
      out[name] = LayaQuestionTranslator.toWireQuestion(question);
    }
    return out;
  }

  /**
   * `choice` 的 criteria：端口的 `{类别: 描述}` → Laya 的 `{类别: null}`。
   *
   * 端口把「描述」也放在 criteria 里（供人类/LLM 阅读），Laya 的 choice 只消费类别名集合；
   * 传 `null` 而非描述，避免描述文本挤占每选项的 token 预算。
   *
   * @param question 端口问题。
   * @returns 类别 → null 的映射；criteria 缺省或不是对象时为空 map。
   */
  private static choiceCriteria(question: DecisionQuestion): Record<string, null> {
    const criteria = question.criteria;
    const out: Record<string, null> = {};
    if (criteria === undefined || Array.isArray(criteria)) {
      return out;
    }
    for (const label of Object.keys(criteria)) {
      out[label] = null;
    }
    return out;
  }

  /**
   * `score` 的 criteria：端口的字符串数组 → 同一份有序等级数组（保持顺序）。
   *
   * @param question 端口问题。
   * @returns 等级标签数组；criteria 缺省或不是数组时为空数组。
   */
  private static scoreCriteria(question: DecisionQuestion): readonly string[] {
    const criteria = question.criteria;
    if (criteria === undefined || !Array.isArray(criteria)) {
      return [];
    }
    return [...criteria];
  }
}
