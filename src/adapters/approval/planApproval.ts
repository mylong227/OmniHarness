import type { ApprovalDecision, ApprovalPort, ApprovalRequest } from '../../ports/approval.js';

/**
 * 规划模式（plan）审批适配器。
 *
 * 行为语义对标 Claude Code 的 plan mode：
 *   - 只允许「只读」类工具（读文件、列目录、检索、规划存储读写、LSP 查询、预算查询等）；
 *   - 拒绝一切会改动工作区或产生副作用的工具（shell、写文件、打补丁、派生子智能体、
 *     rollback、run_goal/run_workflow 等）。
 *
 * fail-closed：白名单以外的工具一律 deny，绝不让「漏网」的可变工具静默放行。
 */

/** 规划模式下允许的只读工具名（显式白名单，新增可变工具默认被拒绝）。 */
const PLAN_ALLOWED_TOOLS = new Set<string>([
  'read_file',
  'list_dir',
  'memory_search',
  'plan_read',
  'plan_write',
  'plan_present',
  'todo_read',
  'budget_status',
  'web_search',
  'registry',
  'tool_search',
  'policy_eval',
  'agent_identity',
  // LSP 查询（只读）
  'lsp_go_to_definition',
  'lsp_find_references',
  'lsp_hover',
  'lsp_status',
]);

/** 规划模式审批选项。 */
export interface PlanApprovalOptions {
  /** 额外放行的只读工具名（用户可扩展白名单）。 */
  readonly extraAllowedTools?: readonly string[];
}

/** 规划模式审批适配器：只读白名单，其余一律拒绝。 */
export class PlanApproval implements ApprovalPort {
  /**
   * 审批器标识：固定为 'plan'，用于区分规划模式只读白名单实现。
   */
  public readonly name = 'plan';

  private readonly allowed: Set<string>;

  public constructor(options: PlanApprovalOptions = {}) {
    this.allowed = new Set(PLAN_ALLOWED_TOOLS);
    for (const tool of options.extraAllowedTools ?? []) {
      this.allowed.add(tool);
    }
  }

  /** 仅在工具命中只读白名单时放行。 */
  public async decide(request: ApprovalRequest): Promise<ApprovalDecision> {
    return this.allowed.has(request.toolName) ? 'allow' : 'deny';
  }
}
