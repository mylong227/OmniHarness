/**
 * 评测与生成路径隔离（T4.6 · H6 · Harness Engineering）。
 *
 * 解决的问题：agent **自评系统性偏高**——当评估器与生成器共享同一份可变状态
 * （同进程对象引用、可被后续写操作改写的产物）时，「评估通过」可能评的是生成后又被
 * 改过的东西，或评估器读到生成器的中间态。隔离原则：**评估只见冻结快照**。
 *
 * 机制：`generate` 产出后立即深拷贝 + 逐层冻结；`evaluate` 只拿快照。生成方对产物
 * 的任何后续修改都进不了评估；评估方也无从借引用改产物。判定确定性：同产物恒同 verdict。
 *
 * fail-closed：产物不可克隆（含函数/循环引用等非结构化数据）时显式抛错，绝不降级为
 * 「用活引用评估」——那正是本模块要消灭的通道。
 *
 * @maturity L1 — 隔离机制是结构保证（冻结快照）；「自评偏差下降」由测试断言（改活引用不改变 verdict）
 * @maturityEvidence tests/unit/isolatedEvaluator.test.ts
 */

/** 隔离评估器选项。 */
export interface IsolatedEvaluatorOptions<G, S = G> {
  /** 生成路径（生产逻辑，返回产物）。 */
  readonly generate: () => G;
  /** 产物投影（可选）：评估前把产物映射为评估关心的形状（须可结构化克隆）。 */
  readonly project?: (artifact: G) => S;
  /** 评估路径：只接收冻结快照，返回 0..1 的 verdict（可异步）。 */
  readonly evaluate: (snapshot: Readonly<S>) => number | Promise<number>;
}

/** 隔离评估结果。 */
export interface IsolatedVerdict<S> {
  /** 评估结论（0..1）。 */
  readonly verdict: number;
  /** 本次评估使用的冻结快照（审计用；与生成方活对象零共享）。 */
  readonly snapshot: Readonly<S>;
}

/**
 * 隔离评估器：生成 → 结构化克隆 → 深冻结 → 评估（D9：class 形态，禁顶层函数）。
 * 评估器拿到的快照与生成方的活对象**零共享**；生成方此后对产物的任何修改不影响本次 verdict。
 *
 * 构造走双工厂（direct / projected）：恒等投影由工厂显式给出，类型层面无任何断言（D9/P4.6）。
 */
export class IsolatedEvaluator<G, S = G> {
  private constructor(
    /** 生成器：产出原始产物 G。 */
    private readonly generate: () => G,
    /** 投影：G → 快照形状 S（direct 工厂给恒等投影）。 */
    private readonly project: (a: G) => S,
    /** 评估器：只接收冻结快照。 */
    private readonly evaluate: (snapshot: Readonly<S>) => number | Promise<number>,
  ) {}

  /**
   * 无投影工厂：产物即快照形状（S = 产物类型）。
   * @param opts 生成器与评估器
   * @returns 隔离评估器实例（S = 产物类型）
   */
  public static direct<S>(opts: {
    generate: () => S;
    evaluate: (snapshot: Readonly<S>) => number | Promise<number>;
  }): IsolatedEvaluator<S, S> {
    return new IsolatedEvaluator<S, S>(opts.generate, (a) => a, opts.evaluate);
  }

  /**
   * 有投影工厂：产物先经 project 映射为快照形状（同时天然剥离敏感字段）。
   * @param opts 生成器、投影与评估器
   * @returns 隔离评估器实例（快照类型 = 投影返回类型）
   */
  public static projected<G, S>(opts: {
    generate: () => G;
    project: (artifact: G) => S;
    evaluate: (snapshot: Readonly<S>) => number | Promise<number>;
  }): IsolatedEvaluator<G, S> {
    return new IsolatedEvaluator<G, S>(opts.generate, opts.project, opts.evaluate);
  }

  /**
   * 执行一次隔离评估。
   * @returns verdict 与本次评估使用的冻结快照
   * @throws 产物不可结构化克隆时抛错（fail-closed：拒绝退回活引用评估）
   */
  public async run(): Promise<IsolatedVerdict<S>> {
    const artifact = this.generate();
    let snapshotValue: S;
    try {
      snapshotValue = structuredClone<S>(this.project(artifact));
    } catch (err) {
      throw new Error(`隔离评估失败：产物不可结构化克隆（拒绝活引用评估）: ${String(err)}`);
    }
    const frozen = this.deepFreeze(snapshotValue);
    const verdict = await this.evaluate(frozen);
    return { verdict, snapshot: frozen };
  }

  /**
   * 深冻结：递归冻结对象与数组（快照防篡改的结构保证）。
   * @param value 任意结构化克隆产物
   * @returns 同一引用（已逐层冻结）
   */
  private deepFreeze<T>(value: T): T {
    if (value !== null && typeof value === 'object') {
      for (const key of Object.keys(value as Record<string, unknown>)) {
        this.deepFreeze((value as Record<string, unknown>)[key]);
      }
      Object.freeze(value);
    }
    return value;
  }
}
