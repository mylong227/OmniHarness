import type {
  ApprovalDecision,
  ApprovalPort,
  ApprovalRequest,
} from '../../ports/runtime/approval.js';

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
  // 文件检索（只读）：grep/glob 仅在磁盘上匹配，不写任何内容，故与 read_file 同级放行。
  'grep',
  'glob',
  'memory_search',
  // 跨会话长期记忆检索（只读）：memory_search 的姊妹工具，同样只读不写（remember 才是写类，不放行）。
  'recall',
  // 读回被外溢的完整工具输出（只读）：不读回则大输出在 plan 模式下永远取不到全文。
  'spill_read',
  'plan_read',
  'plan_write',
  'plan_present',
  'todo_read',
  'budget_status',
  'web_search',
  // 读网页与读图（P2-⑬）：只读外部内容/本地图片，不写任何东西，与 read_file 同级放行。
  'web_fetch',
  'view_image',
  'registry',
  'tool_search',
  'policy_eval',
  'agent_identity',
  // LSP 查询（只读）。全族必须齐：漏登记即被 fail-closed 误拒（`lsp_workspace_symbols`
  // 由 `ConfigToolRegistry.registerAuxiliaryTools` 在 `lsp.workspaceSymbols` 存在时注册，
  // 曾漏登记 —— 见 tests/unit/planApprovalReadonlyTools.test.ts）。
  'lsp_go_to_definition',
  'lsp_find_references',
  'lsp_hover',
  'lsp_status',
  'lsp_diagnostics',
  'lsp_document_symbols',
  'lsp_code_action',
  'lsp_workspace_symbols',
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

  /** 只读工具白名单（内置 + 用户扩展），命中才放行。 */
  private readonly allowed: Set<string>;

  /**
   * @param options 规划模式审批选项（额外放行的只读工具名）。
   */
  public constructor(options: PlanApprovalOptions = {}) {
    this.allowed = new Set(PLAN_ALLOWED_TOOLS);
    for (const tool of options.extraAllowedTools ?? []) {
      this.allowed.add(tool);
    }
  }

  /** 仅在工具命中只读白名单时放行。
   * @param request 审批请求（取工具名匹配白名单）。
   * @returns 白名单内 'allow'，其余一律 'deny'（fail-closed）。
   */
  public async decide(request: ApprovalRequest): Promise<ApprovalDecision> {
    return this.allowed.has(request.toolName) ? 'allow' : 'deny';
  }
}
