/**
 * 工作流 DAG 的**关键路径优先**（critical-path / bottom-level priority，HEFT 的简化版）。
 *
 * ## 问题
 *
 * `WorkflowRunner` 按拓扑层执行；同一层超过并发上限时，谁先拿到槽位原来只由声明顺序决定。
 * 若先启动的是「后面没有多少工作」的短分支，真正决定总工期的长链反而排在后面——在并发受限
 * 时会把 makespan 拉长。经典列表调度（Graham / HEFT）用**底位级**（bottom level）排序：
 *
 * ```text
 * level(s) = 1 + max{ level(c) : c 是 s 的后继 }   // 叶子 = 1
 * 优先级 = level(s) 降序；并列保持声明顺序
 * ```
 *
 * 单位权重下，`level(s)` 就是 s 到汇点的最长步数；优先启动它，等于先喂饱关键链。Graham 的
 * 列表调度界 `makespan ≤ (2 − 1/m)·OPT` 对任意静态优先级成立；关键路径优先在实践中通常更接近下界。
 *
 * ## 边界
 *
 * 这是**启发式**，不是最优调度（DAG 受限并发的 makespan 最优是 NP-hard）；本类只改“同层内
 * 谁先启动”，不改依赖、失败传播、条件裁决与并发上限。
 *
 * @maturity L2 — 真实 DAG 底位级计算；未使用步骤耗时估计（单位权重）与抢占
 * @maturityEvidence tests/unit/workflowPriority.test.ts
 */
import type { WorkflowStep } from './workflowTypes.ts';

/** 关键路径优先级。 */
export class WorkflowPriority {
  /**
   * 计算各步骤的底位级（到汇点的最长步数）。
   * @param steps 工作流步骤（依赖已校验为 DAG）。
   * @returns 步骤 id → 底位级（≥1）。
   */
  public static rank(steps: readonly WorkflowStep[]): ReadonlyMap<string, number> {
    const byId = new Map(steps.map((step) => [step.id, step]));
    const children = new Map<string, string[]>();
    for (const step of steps) {
      children.set(step.id, []);
    }
    for (const step of steps) {
      for (const dep of step.dependsOn ?? []) {
        const list = children.get(dep);
        if (list !== undefined) list.push(step.id);
      }
    }
    const memo = new Map<string, number>();
    const visiting = new Set<string>();
    const levelOf = (id: string): number => {
      const cached = memo.get(id);
      if (cached !== undefined) return cached;
      if (visiting.has(id)) return 1; // 环已由 WorkflowGuard 拒绝；这里只做无栈溢出兜底。
      visiting.add(id);
      const kids = children.get(id) ?? [];
      let max = 0;
      for (const child of kids) max = Math.max(max, levelOf(child));
      visiting.delete(id);
      const level = max + 1;
      memo.set(id, level);
      return level;
    };
    for (const step of steps) levelOf(step.id);
    // 防御：未知依赖不应让 rank 少项（调用方已校验，这里只保证返回值覆盖全部步骤）。
    for (const step of steps) {
      if (!memo.has(step.id) && byId.has(step.id)) memo.set(step.id, 1);
    }
    return memo;
  }

  /**
   * 按底位级降序、并列保持原顺序排序。
   * @param ids 待排序步骤 id（原顺序）。
   * @param rank 底位级表。
   * @returns 新数组。
   */
  public static order(ids: readonly string[], rank: ReadonlyMap<string, number>): string[] {
    const index = new Map(ids.map((id, i) => [id, i]));
    return [...ids].sort(
      (a, b) =>
        (rank.get(b) ?? 1) - (rank.get(a) ?? 1) || (index.get(a) ?? 0) - (index.get(b) ?? 0),
    );
  }
}
