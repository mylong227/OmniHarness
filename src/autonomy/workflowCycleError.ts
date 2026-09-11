import { OmniError, ErrorCode } from '../omniError.js';

export class WorkflowCycleError extends OmniError {
  public constructor() {
    super(ErrorCode.WORKFLOW_CYCLE, '工作流 DAG 存在环（依赖关系无法拓扑排序）');
  }
}
