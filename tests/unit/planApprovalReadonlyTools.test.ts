/**
 * 探针：plan（计划模式）只读白名单的**完整性**。
 *
 * 被验证的**声称**（三处，互相印证）：
 *  ① `src/adapters/approval/planApproval.ts` 类注释：plan 模式「只允许『只读』类工具
 *     （读文件、列目录、检索、规划存储读写、LSP 查询、预算查询等）」；
 *  ② `src/server/services/approvalTierCatalog.ts` 用户可见档位描述：
 *     plan = 「只读规划：仅放行**读取与检索类**工具，不动工作区」；
 *  ③ `docs/TASK_BOARD.md`（LSP 全局符号搜索条目）明确写着 `lsp_workspace_symbols`
 *     「**我落地注册**（按能力而非端口存在放行）**并进规划模式只读白名单**」。
 *
 * 实测：`PLAN_ALLOWED_TOOLS` 列了 7 个 LSP 工具却漏掉 `lsp_workspace_symbols`
 * （该工具由 `ConfigToolRegistry.registerAuxiliaryTools` 在 `lsp.workspaceSymbols`
 * 存在时注册，仓库自带 `tests/unit/lspToolWiring.test.ts` 断言它真的进了装配产物）
 * ⇒ 生产路径上模型在 plan 模式调用它会被 fail-closed 误拒，与 ①②③ 全部矛盾。
 * 同源漏登记还有两个纯读工具：`recall`（跨会话事实检索，`memory_search` 的姊妹工具，
 * 后者已在白名单）与 `spill_read`（读回被外溢的完整输出）。
 * 仓库此前已因同一形态缺陷补过一轮（`docs/TASK_BOARD.md`：「plan 模式只读白名单
 * 漏登记新工具：新增的 grep/glob/lsp_diagnostics 未登记 ⇒ 被 fail-closed 误拒」）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PlanApproval } from '../../src/adapters/approval/planApproval.js';
import {
  LSP_GO_TO_DEFINITION_TOOL_NAME,
  LSP_FIND_REFERENCES_TOOL_NAME,
  LSP_HOVER_TOOL_NAME,
  LSP_STATUS_TOOL_NAME,
  LSP_DIAGNOSTICS_TOOL_NAME,
  LSP_DOCUMENT_SYMBOLS_TOOL_NAME,
  LSP_CODE_ACTION_TOOL_NAME,
  LSP_WORKSPACE_SYMBOLS_TOOL_NAME,
} from '../../src/adapters/lsp/lspToolNames.js';

/** 构造审批请求（plan 审批只读 toolName）。 */
const req = (toolName: string): { sessionId: string; toolName: string; target: string } => ({
  sessionId: 's1',
  toolName,
  target: '',
});

/** LSP 工具名全族（唯一事实源：`lspToolNames.ts` 的导出常量）。 */
const LSP_TOOLS: readonly string[] = [
  LSP_GO_TO_DEFINITION_TOOL_NAME,
  LSP_FIND_REFERENCES_TOOL_NAME,
  LSP_HOVER_TOOL_NAME,
  LSP_STATUS_TOOL_NAME,
  LSP_DIAGNOSTICS_TOOL_NAME,
  LSP_DOCUMENT_SYMBOLS_TOOL_NAME,
  LSP_CODE_ACTION_TOOL_NAME,
  LSP_WORKSPACE_SYMBOLS_TOOL_NAME,
];

/** 纯读工具（读取 / 检索类；不写工作区、不产生副作用）。 */
const READONLY_TOOLS: readonly string[] = [
  'read_file',
  'list_dir',
  'grep',
  'glob',
  'memory_search',
  'recall',
  'spill_read',
  'plan_read',
  'todo_read',
  'budget_status',
  'policy_eval',
  'agent_identity',
  'registry',
  'tool_search',
];

test('plan 模式：LSP 工具全族都必须放行（`lsp_workspace_symbols` 曾被漏登记）', async () => {
  const plan = new PlanApproval();
  for (const tool of LSP_TOOLS) {
    assert.strictEqual(
      await plan.decide(req(tool)),
      'allow',
      `${tool} 是只读 LSP 查询，应被 plan 放行`,
    );
  }
});

test('plan 模式：读取 / 检索类工具都必须放行（`recall` / `spill_read` 曾被漏登记）', async () => {
  const plan = new PlanApproval();
  for (const tool of READONLY_TOOLS) {
    assert.strictEqual(
      await plan.decide(req(tool)),
      'allow',
      `${tool} 属「读取与检索类」，应被 plan 放行（档位描述见 approvalTierCatalog）`,
    );
  }
});

test('plan 模式：写类 / 副作用类工具仍然一律拒绝（白名单不得被放宽）', async () => {
  const plan = new PlanApproval();
  for (const tool of [
    'shell',
    'shell_interactive',
    'shell_job',
    'write_file',
    'edit',
    'apply_patch',
    'subagent',
    'delegate',
    'run_goal',
    'run_workflow',
    'todo_write',
    'remember',
    'sketch_write',
    'browser_screenshot',
    'checkpoint',
    'rollback',
    'run_code',
    'future_mutation_tool',
  ]) {
    assert.strictEqual(await plan.decide(req(tool)), 'deny', `${tool} 在 plan 模式必须被拒绝`);
  }
});
