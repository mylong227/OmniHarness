import type { PlanDraft, PlanPort, PlanState } from '../../ports/plan.js';

/** 内存计划端口：会话级计划态，生命周期 drafting→presented→approved/rejected。 */
export class MemoryPlan implements PlanPort {
  /** 适配器标识：用于端口注册与诊断日志归组（固定值 'memory'）。 */
  public readonly name = 'memory';
  /** 当前计划态（未起草时为 null；随 write/present/decide 整体替换）。 */
  private state: PlanState | null = null;

  /** 起草计划：以草稿重置计划态回 drafting（改写已批准计划需重新呈现审批）。
   * @param draft 计划草稿（标题与步骤列表；内部拷贝步骤数组防外部突变）。
   
 * @returns 无返回值。
*/
  public write(draft: PlanDraft): void {
    // 重新起草回到 drafting：已批准的计划被改写后需再次呈现审批。
    this.state = {
      title: draft.title,
      steps: draft.steps.slice(),
      status: 'drafting',
    };
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
