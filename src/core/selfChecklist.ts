/**
 * 自验证清单（T4.1 · H1 · Harness Engineering）。
 *
 * 解决的问题：「假完成」——agent 声称任务完成，但产物缺证据（测试红 / 文件不存在 /
 * 占位符残留 / 断言空洞）。点式自评（"我觉得做完了"）系统性偏高，必须以**显式判据 +
 * 机械验证 + fail-closed 判定**替代：清单里任何一条判据不过，整体即「未完成」。
 *
 * 用法（产出/执行前两段式）：
 *  1. **执行前**列出完成判据（`criterion(id, 描述, 验证函数)`）——把「什么叫做完」显式化；
 *  2. **声称完成前**跑 `evaluate()` 并只接受 `passed === true`（`assertDone` 直接抛错）。
 *
 * 内置「假完成探测器」：产物文本含 TODO/TBD/占位/后续补 等未完成标记 → 自动判负
 * （占位符与"已完成"声明在逻辑上互斥，这是可机械检验的矛盾）。
 */
/** 单条判据的验证结果。 */
export interface CriterionResult {
  /** 判据 id（稳定，用于报告与回归对照）。 */
  readonly id: string;
  /** 判据描述（什么叫「做完」）。 */
  readonly desc: string;
  /** 是否通过。 */
  readonly passed: boolean;
  /** 失败原因（passed 时为 undefined）。 */
  readonly reason?: string;
}

/** 清单整体判定。 */
export interface ChecklistVerdict {
  /** 全部判据通过才为 true（fail-closed）。 */
  readonly passed: boolean;
  /** 各判据明细。 */
  readonly results: readonly CriterionResult[];
  /** 未通过判据的 id 列表（passed 时为空数组）。 */
  readonly failures: readonly string[];
}

/** 完成判据：验证函数返回 boolean；异步判据用 AsyncCriterion。 */
export interface Criterion {
  readonly id: string;
  readonly desc: string;
  readonly verify: () => boolean | Promise<boolean>;
}

/** 「假完成」文本标记：产物中出现即与完成声明矛盾。 */
const PLACEHOLDER_MARKS: readonly RegExp[] = [
  /\bTODO\b/,
  /\bTBD\b/,
  /\bFIXME\b/,
  /占位/,
  /后续补/,
  /待实现/,
  /以后再/,
];

/**
 * 自验证清单：显式判据集 + 机械验证 + fail-closed 判定。
 */
export class SelfChecklist {
  /** 判据注册表（id → 判据；重复 id 以最后登记为准）。 */
  private readonly criteria = new Map<string, Criterion>();

  /**
   * 登记一条完成判据（重复 id 覆盖——以最后一次登记为准）。
   * @param id 判据 id（稳定）
   * @param desc 判据描述
   * @param verify 验证函数（false/抛错 = 不过）
   * @returns this（链式登记）
   */
  public criterion(id: string, desc: string, verify: () => boolean | Promise<boolean>): this {
    this.criteria.set(id, { id, desc, verify });
    return this;
  }

  /**
   * 批量登记「产物文本无占位符」判据：claims 中任一文本含 TODO/TBD/占位/待实现 等标记即判负。
   * @param claims 产物文本（如提交说明、总结报告、代码片段）
   * @returns this（链式登记）
   */
  public noPlaceholders(...claims: readonly string[]): this {
    return this.criterion(
      'no-placeholders',
      '产物文本不得含未完成标记（TODO/TBD/FIXME/占位/后续补/待实现/以后再）',
      () => claims.every((c) => !PLACEHOLDER_MARKS.some((re) => re.test(c))),
    );
  }

  /**
   * 评估全部判据（fail-closed：验证函数抛错 = 不过）。
   * @returns 整体判定与逐条明细
   */
  public async evaluate(): Promise<ChecklistVerdict> {
    const results: CriterionResult[] = [];
    for (const c of this.criteria.values()) {
      try {
        const ok = await c.verify();
        results.push(
          ok
            ? { id: c.id, desc: c.desc, passed: true }
            : { id: c.id, desc: c.desc, passed: false, reason: '验证返回 false' },
        );
      } catch (err) {
        results.push({ id: c.id, desc: c.desc, passed: false, reason: String(err) });
      }
    }
    const failures = results.filter((r) => !r.passed).map((r) => r.id);
    return { passed: failures.length === 0, results, failures };
  }

  /**
   * 断言完成（fail-closed）：任一判据不过即抛错，把「假完成」挡在声明之前。
   * @returns 无返回值（通过即正常返回）；任一判据未通过时抛错（错误信息含全部失败判据 id）
   * @throws 任一判据未通过时抛错
   */
  public async assertDone(): Promise<void> {
    const verdict = await this.evaluate();
    if (!verdict.passed) {
      const detail = verdict.results
        .filter((r) => !r.passed)
        .map((r) => `${r.id}(${r.reason ?? '未通过'})`)
        .join('; ');
      throw new Error(`自验证清单未通过（假完成拦截）：${detail}`);
    }
  }
}
