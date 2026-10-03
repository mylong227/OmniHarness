import { MUTATING_TOOLS } from '../core/toolGate.js';
import type { WorkflowStep } from './workflowTypes.js';

/**
 * @beta
 * 工作流**同层并发策略**的判定类（2026-10-03 第六轮修看板 §8.1）。
 *
 * 背景：工作流步骤**共享父工作区**（要供后续步骤使用产出），这与 `SubagentOrchestrator` 的
 * worktree 隔离**语义相反**。于是同层里若有多个步骤都可能写文件，并发执行会互相覆盖同一文件，
 * 且没有任何冲突检测。本类给出"该层是否必须退化为串行"的判据。
 *
 * 判据取向：**保守**。未声明 `tools`（即拿到工具全集）或声明的集合里含任一写类工具 ⇒ 视为可能写。
 * 乐观放行（把写类当只读）会直接产出并发覆盖与不可复现的结果，故宁可多串行几层。
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
   * 该层是否必须**串行**执行（＞1 步且其中任一步可能写文件）。
   *
   * 单步层天然无需判断（串行与并发等价）；只读层（显式声明且不含写类工具）保持并发。
   * @param steps 本层待执行步骤（已剔除被跳过的）。
   * @returns 必须串行为 true。
   */
  public static shouldSerialize(steps: readonly WorkflowStep[]): boolean {
    return steps.length > 1 && steps.some((step) => WorkflowLayerPolicy.mayWrite(step));
  }
}
