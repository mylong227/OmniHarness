/**
 * 决策引擎端口（System-1 类型化判断）：用单次前向的类型化决策，替代 LLM 长推理做
 * 高频结构化判断点（参考 Laya 的 `choice` / `score` / `noul` 原语）。
 *
 * 设计取向（六边形）：本文件属 `ports/**`，**第三方-free**，不依赖任何推理实现；
 * 具体推理（本地 Python `laya` 包 / onnxruntime / 远程）由 `adapters/**` 承载。
 *
 * fail-open 铁律：任何实现都不得在不可用时抛错阻断主流程——`decide` 须返回
 * `available:false`，让调用方回落到原有 LLM 路径。这与本仓低频安全边界（护栏
 * fail-closed）取向不同：决策引擎是「质量 / 成本信号」，不是安全边界。
 */

/** 决策原语类型。 */
export type DecisionKind = 'choice' | 'score' | 'noul';

/** 单题定义（参考 Laya 的 questions 字典项）。 */
export interface DecisionQuestion {
  /** 原语类型。 */
  readonly kind: DecisionKind;
  /** 对模型的指令 / 问题陈述。 */
  readonly instructions: string;
  /**
   * 选项定义：`choice` 为 `{类别: 描述}`；`score` 为有序等级标签数组；
   * `noul` 一般不带 criteria（只问「是/否」概率）。
   */
  readonly criteria?: Readonly<Record<string, string>> | readonly string[];
}

/** 一次决策请求（待判断的 state + 问题集）。 */
export interface DecisionRequest {
  /** 待判断的文本状态（代码 / 邮件 / 工单 / JSON 文档等）。 */
  readonly state: string;
  /** 问题集，键为问题名。 */
  readonly questions: Readonly<Record<string, DecisionQuestion>>;
}

/** 单题答案。 */
export interface DecisionAnswer {
  /** `choice` 选中的类别。 */
  readonly choice?: string;
  /** `score` 的有序打分（如 0–2）。 */
  readonly score?: number;
  /** `noul`：「答案为是」的概率，区间 [0,1]。 */
  readonly noul?: number;
  /** 实现原始输出（透传，便于审计 / 调试）。 */
  readonly raw?: unknown;
}

/** 决策响应。 */
export interface DecisionResponse {
  /** 各题答案，键与请求问题集对齐。 */
  readonly answers: Readonly<Record<string, DecisionAnswer>>;
  /** 实际使用的模型 / checkpoint 标识。 */
  readonly model?: string;
  /** 引擎是否可用（不可用时调用方回落 LLM，fail-open）。 */
  readonly available: boolean;
  /** 不可用 / 退化原因（可选）。 */
  readonly note?: string;
}

/**
 * 决策引擎端口：System-1 类型化判断（替代 LLM 长推理做高频结构化决策）。
 */
export interface DecisionEngine {
  /** 端口名（如 `laya`）。 */
  readonly name: string;

  /**
   * 引擎当前是否可用（权重 / 后端就绪）。实现可缓存探测结果。
   *
   * @returns 可用时为 true。
   */
  isAvailable(): boolean | Promise<boolean>;

  /**
   * 单次前向类型化决策。
   *
   * 失败 / 超时 / 后端不可用均**不得抛错**——返回 `{ available:false }`（fail-open）。
   *
   * @param request 决策请求（state + 问题集）。
   * @returns 决策响应；不可用时 `available:false`、answers 为空。
   */
  decide(request: DecisionRequest): Promise<DecisionResponse>;
}
