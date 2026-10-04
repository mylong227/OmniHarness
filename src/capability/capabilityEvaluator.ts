/**
 * 通用资产评估器（Wave B · `EvaluatorPort` 的实现，ADR-0009）。
 *
 * 职责只有一件：**按类型声明的度量去量**，并把结果如实分级成 `RewardVerdict`——
 * 度量口径完全来自 `CapabilitySchema.evalContract`（Ω-4），本类不含任何领域知识，
 * 因此接入新资产类型时它零改动。
 *
 * 分级口径（与 Wave A 的可验证奖励**同一条诚实线**）：
 * - 类型未注册 ⇒ `unverifiable:no-schema`；
 * - 契约抛错 ⇒ `unverifiable:contract-error:<原因>`；
 * - 量出来的分非有限数（NaN/Infinity）⇒ `unverifiable:non-finite`（不把脏数字当分数）；
 * - 正常量出 ⇒ `verified`（reward = 分；**判低分也是判定**）。
 *
 * 单一写者纪律：本类**只出判据**，不写 `CapabilityRecord.fitness`（写入由调用方/注册表决定，
 * 避免「谁都能改适应度」）。
 *
 * @maturity L1 — 四类分级与「度量来自类型声明」判据钉死（含未注册类型即 unverifiable 的负例）
 * @maturityEvidence tests/unit/capabilityEvaluator.test.ts
 */
import type {
  CapabilityRecord,
  CapabilitySchemaRegistryPort,
  EvalContext,
} from '../ports/capability.js';
import type { EvaluatorPort, RewardVerdict } from '../ports/runtime/evolution.js';

/** 评估器选项。 */
export interface CapabilityEvaluatorOptions {
  /** 类型注册表（度量口径的唯一来源）。 */
  readonly schemas: CapabilitySchemaRegistryPort;
  /** 评估器标识（进判据来源与 `fitness.evaluator`；缺省 `capability-evaluator`）。 */
  readonly evaluator?: string | undefined;
  /** 评估上下文透传（工况桶键等；缺省只带评估器标识）。 */
  readonly context?: EvalContext | undefined;
}

/** 通用资产评估器：类型声明的度量 + 诚实分级。 */
export class CapabilityEvaluator implements EvaluatorPort {
  /** 类型注册表。 */
  private readonly schemas: CapabilitySchemaRegistryPort;
  /** 评估器标识。 */
  private readonly evaluator: string;
  /** 额外评估上下文（工况桶键）。 */
  private readonly context: EvalContext | undefined;

  /**
   * @param opts 类型注册表 / 评估器标识 / 评估上下文
   */
  public constructor(opts: CapabilityEvaluatorOptions) {
    this.schemas = opts.schemas;
    this.evaluator = opts.evaluator ?? 'capability-evaluator';
    this.context = opts.context;
  }

  /**
   * 评估一件资产（fail-closed：量不出来的情形一律 `verifiable: false`）。
   * @param record 资产实例
   * @returns 判据明细
   */
  public async evaluate(record: CapabilityRecord): Promise<RewardVerdict> {
    if (!this.schemas.has(record.schemaKind)) {
      return {
        reward: 0,
        verifiable: false,
        reason: `unverifiable:no-schema:${record.schemaKind}`,
      };
    }
    try {
      const schema = this.schemas.schemaOf(record.schemaKind);
      const ctx: EvalContext = {
        evaluator: this.evaluator,
        ...(this.context?.bucketKey !== undefined ? { bucketKey: this.context.bucketKey } : {}),
      };
      const benchmark = schema.evalContract(ctx);
      const score = await benchmark(record.asset);
      if (typeof score !== 'number' || !Number.isFinite(score)) {
        return { reward: 0, verifiable: false, reason: 'unverifiable:non-finite' };
      }
      return { reward: score, verifiable: true, reason: `verified:${record.schemaKind}` };
    } catch (err) {
      return {
        reward: 0,
        verifiable: false,
        reason: `unverifiable:contract-error:${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 评估并产出可写回记录的 `fitness`（**调用方决定是否写**——本类不做单一写者以外的动作）。
   * @param record 资产实例
   * @param evaluatedAt ISO 时间戳（由调用方注入，评估器不读墙钟）
   * @returns 适应度或 undefined（不可验证时不产伪适应度）
   */
  public async fitnessOf(
    record: CapabilityRecord,
    evaluatedAt: string,
  ): Promise<CapabilityRecord['fitness']> {
    const verdict: RewardVerdict = await this.evaluate(record);
    if (!verdict.verifiable) return undefined;
    return { benchmark: verdict.reward, evaluatedAt, evaluator: this.evaluator };
  }
}
