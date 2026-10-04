import { MUTATING_TOOLS } from '../core/toolGate.js';
import type { WorkflowStep } from './workflowTypes.js';

/**
 * @beta
 * 工作流**同层并发策略**的判定类（2026-10-03 第六轮修看板 §8.1；2026-10-04 第三十轮加写集声明契约）。
 *
 * 背景：工作流步骤**共享父工作区**（要供后续步骤使用产出），这与 `SubagentOrchestrator` 的
 * worktree 隔离**语义相反**。于是同层里若有多个步骤都可能写文件，并发执行会互相覆盖同一文件，
 * 且没有任何冲突检测。本类给出"该层是否必须退化为串行"的判据。
 *
 * 判据取向：**保守优先，知情放行**。
 *  - 未声明 `tools`（即拿到工具全集）或声明的集合里含任一写类工具 ⇒ 视为可能写；
 *  - 层内有任何写者且还有只读步骤在场 ⇒ 串行（读者读集未声明，读-写一致性竞争排除不了）；
 *  - **全层皆写者**时，只有当每个写者都给出知情声明（`tools` 显式约束 + `writes` 写集已声明）
 *    且各写集**两两不相交**，才保持并发（看板 G2 遗留的"精确并发"就此收口）；
 *  - 其余情形（任一写者缺声明、`tools` 未约束 ⇒ 写集不可预测声明不可采信）⇒ 串行。
 * 乐观放行（把写类当只读、或采信不知情的声明）会直接产出并发覆盖与不可复现的结果，故宁可多串行几层。
 */
export class WorkflowLayerPolicy {
  /**
   * 该步骤是否**可能写文件**。
   * @param step 工作流步骤。
   * @returns 可能写文件为 true。
   */
  public static mayWrite(step: WorkflowStep): boolean {
    if (step.tools === undefined) {
      return true;
    }
    return step.tools.some((name) => MUTATING_TOOLS.has(name));
  }

  /**
   * 该层是否必须**串行**执行。
   *
   * 单步层天然无需判断（串行与并发等价）；只读层（显式声明且不含写类工具）保持并发；
   * 层内**有任何写者**时保守串行——**除非**全层每个步骤都是写者、全员给出知情声明
   * （`tools` 显式约束 + `writes` 写集已声明）且各写集两两不相交（G2 收尾的**声明式精确并发**）。
   *
   * 为什么精确并发要求「全层皆写者」：只读步骤的**读集**没有声明，读者与写者并发存在
   * 读-写一致性竞争（读者看到写者改动的前后是非确定的）⇒ 有读者在场时写集声明排除不了
   * 该竞争，保持旧的保守串行。
   * @param steps 本层待执行步骤（已剔除被跳过的）。
   * @returns 必须串行为 true。
   */
  public static shouldSerialize(steps: readonly WorkflowStep[]): boolean {
    if (steps.length <= 1) {
      return false;
    }
    const writers = steps.filter((step) => WorkflowLayerPolicy.mayWrite(step));
    if (writers.length === 0) {
      return false;
    }
    // 有只读步骤在场 ⇒ 读-写一致性竞争无法用写集声明排除 ⇒ 保守串行（第六轮原判据）。
    if (writers.length !== steps.length) {
      return true;
    }
    // 知情声明门槛：`tools` 未约束的步骤持有全工具集 ⇒ 其写集不可预测 ⇒ `writes` 声明不可采信。
    const fullyDeclared = writers.every(
      (step) => step.tools !== undefined && step.writes !== undefined,
    );
    if (!fullyDeclared) {
      return true;
    }
    return !WorkflowLayerPolicy.declaredWritesDisjoint(writers);
  }

  /**
   * 全部写者的声明写集是否**两两不相交**（判定输入的前提：每个写者 `writes` 均已声明）。
   * @param writers 可能写的步骤（`writes` 均非 undefined）。
   * @returns 两两不相交为 true。
   */
  private static declaredWritesDisjoint(writers: readonly WorkflowStep[]): boolean {
    for (let i = 0; i < writers.length; i++) {
      const a = writers[i];
      if (a === undefined) {
        continue;
      }
      for (let j = i + 1; j < writers.length; j++) {
        const b = writers[j];
        if (
          a.writes !== undefined &&
          b !== undefined &&
          b.writes !== undefined &&
          WorkflowLayerPolicy.writeSetsConflict(a.writes, b.writes)
        ) {
          return false;
        }
      }
    }
    return true;
  }

  /**
   * 两个声明写集是否冲突（存在任一路径对冲突）。
   * @param a 写集 A。
   * @param b 写集 B。
   * @returns 冲突为 true。
   */
  private static writeSetsConflict(a: readonly string[], b: readonly string[]): boolean {
    return a.some((pathA) => b.some((pathB) => WorkflowLayerPolicy.pathsConflict(pathA, pathB)));
  }

  /**
   * 单路径对冲突判定：相等，或一方是另一方的**目录前缀**（目录写法覆盖其下文件）。
   * 归一化：反斜杠归一为正斜杠、去尾斜杠、去首尾空白。归一化后为空串视为「无法判别」⇒ 冲突。
   * @param rawPath 路径 A（声明原文）。
   * @param otherPath 路径 B（声明原文）。
   * @returns 冲突为 true。
   */
  private static pathsConflict(rawPath: string, otherPath: string): boolean {
    const x = WorkflowLayerPolicy.normalizeWritePath(rawPath);
    const y = WorkflowLayerPolicy.normalizeWritePath(otherPath);
    if (x === '' || y === '') {
      return true;
    }
    return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
  }

  /**
   * 写集路径归一化：反斜杠归一为正斜杠、去尾斜杠、去首尾空白。
   * @param raw 声明原文。
   * @returns 归一化路径。
   */
  private static normalizeWritePath(raw: string): string {
    return raw.replaceAll('\\', '/').replace(/\/+$/, '').trim();
  }
}
