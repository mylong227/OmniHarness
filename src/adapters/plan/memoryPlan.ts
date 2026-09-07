import type { PlanDraft, PlanPort, PlanState } from '../../ports/plan.js';

/** 内存计划端口：会话级计划态，生命周期 drafting→presented→approved/rejected。 */
export class MemoryPlan implements PlanPort {
  readonly name = 'memory';
  private state: PlanState | null = null;

  write(draft: PlanDraft): void {
    // 重新起草回到 drafting：已批准的计划被改写后需再次呈现审批。
    this.state = {
      title: draft.title,
      steps: draft.steps.slice(),
      status: 'drafting',
    };
  }

  present(): void {
    if (this.state === null) {
      return;
    }
    this.state = {
      ...this.state,
      status: 'presented',
      presentedAt: new Date().toISOString(),
    };
  }

  decide(decision: 'approve' | 'reject'): void {
    if (this.state === null) {
      return;
    }
    this.state = { ...this.state, status: decision === 'approve' ? 'approved' : 'rejected' };
  }

  get(): PlanState | null {
    return this.state;
  }
}
