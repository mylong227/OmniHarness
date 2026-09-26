import { OmniError, ErrorCode } from '../omniError.js';

/**
 * 工作流 DAG 不合法（依赖关系无法拓扑排序 / id 重复 / 依赖悬空）。
 *
 * 为什么带上 `detail`：三类错误原先坍缩成同一句「存在环」，模型只知道「计划有问题」，
 * 不知道是哪个子任务写错了——只能盲改整个 spec。现在每类都点名到步骤 id，并说明是哪一种
 * 错误（重复 id / 悬空依赖 / 真环），使模型能定位并就地修好（任务拆解能力的直接瓶颈之一）。
 */
export class WorkflowCycleError extends OmniError {
  /**
   * @param detail 具体原因（含涉事步骤 id）；缺省时保留历史文案（向后兼容既有断言）。
   */
  public constructor(detail?: string) {
    super(
      ErrorCode.WORKFLOW_CYCLE,
      detail === undefined
        ? '工作流 DAG 存在环（依赖关系无法拓扑排序）'
        : `工作流 DAG 不合法：${detail}`,
    );
  }
}
