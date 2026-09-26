import type { PlanDraft, PlanPort, PlanState, PlanStep } from '../../ports/runtime/plan.js';

/** 内存计划端口：会话级计划态，生命周期 drafting→presented→approved/rejected。 */
export class MemoryPlan implements PlanPort {
  /** 适配器标识：用于端口注册与诊断日志归组（固定值 'memory'）。 */
  public readonly name = 'memory';
  /** 当前计划态（未起草时为 null；随 write/present/decide 整体替换）。 */
  private state: PlanState | null = null;

  /** 起草计划：以草稿重置计划态回 drafting（改写已批准计划需重新呈现审批）。
   *
   * **例外（2026-09-26 审计 F14）**：若计划已 `approved` 且本次草稿的**步骤集合逐字未变**
   * （只有 `status` 回填等差异），则**保持 approved**，不回落 drafting。
   * 理由：唯一的进度回填途径就是再次 `plan_write`（没有增量工具），而回落 drafting 会立刻
   * 重新锁死全部写类工具直到用户再次审批 —— 于是「汇报进度」这一步反而把执行冻住。
   * 步骤集合变化（增删/改写描述）仍按原语义回落 drafting 并要求重新审批。
   * @param draft 计划草稿（标题与步骤列表；内部拷贝步骤数组防外部突变）。
   * @returns 无返回值。
   */
  public write(draft: PlanDraft): void {
    const keepApproved =
      this.state?.status === 'approved' && MemoryPlan.sameStepSet(this.state.steps, draft.steps);
    this.state = {
      title: draft.title,
      steps: draft.steps.slice(),
      status: keepApproved ? 'approved' : 'drafting',
      ...(keepApproved && this.state?.presentedAt !== undefined
        ? { presentedAt: this.state.presentedAt }
        : {}),
    };
  }

  /**
   * 两组步骤是否**同一集合**（数量、顺序与描述逐字相同；`status` 不参与比较）。
   * @param before 原步骤列表。
   * @param after 新步骤列表。
   * @returns 集合相同时为 true。
   */
  private static sameStepSet(before: readonly PlanStep[], after: readonly PlanStep[]): boolean {
    if (before.length !== after.length) {
      return false;
    }
    for (let i = 0; i < before.length; i += 1) {
      if (before[i]?.description !== after[i]?.description) {
        return false;
      }
    }
    return true;
  }

  /** 将计划呈现给用户：状态置为 presented 并记录呈现时间戳（无状态则空操作）。
   * @returns 无返回值。
   */
  public present(): void {
    if (this.state === null) {
      return;
    }
    this.state = {
      ...this.state,
      status: 'presented',
      presentedAt: new Date().toISOString(),
    };
  }

  /** 审批决策：approve→approved、reject→rejected；无计划态则空操作。
   * @param decision 审批结论（approve 或 reject）。
   
   * @returns 无返回值。
   */
  public decide(decision: 'approve' | 'reject'): void {
    if (this.state === null) {
      return;
    }
    this.state = { ...this.state, status: decision === 'approve' ? 'approved' : 'rejected' };
  }

  /** 返回当前计划态（未起草则为 null）。
   * @returns 当前计划态对象（标题/步骤/状态/呈现时间）；从未起草时为 null。
   */
  public get(): PlanState | null {
    return this.state;
  }
}
