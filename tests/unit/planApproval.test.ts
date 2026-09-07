import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlanApproval } from '../../src/adapters/approval/planApproval.js';

const req = (toolName: string) => ({
  sessionId: 's1',
  toolName,
  target: '',
});

test('plan 模式：只读工具放行（read_file / list_dir / memory_search / LSP 查询）', async () => {
  const plan = new PlanApproval();
  for (const tool of [
    'read_file',
    'list_dir',
    'memory_search',
    'plan_read',
    'plan_write',
    'todo_read',
    'budget_status',
    'web_search',
    'lsp_go_to_definition',
    'lsp_find_references',
    'lsp_hover',
    'lsp_status',
    'policy_eval',
    'agent_identity',
    'registry',
    'tool_search',
  ]) {
    assert.strictEqual(await plan.decide(req(tool)), 'allow', `${tool} 应被 plan 模式放行`);
  }
});

test('plan 模式：可变工具一律拒绝（fail-closed 不漏网）', async () => {
  const plan = new PlanApproval();
  for (const tool of [
    'shell',
    'write_file',
    'apply_patch',
    'subagent',
    'rollback',
    'todo_write',
    'run_goal',
    'run_workflow',
    'checkpoint',
  ]) {
    assert.strictEqual(await plan.decide(req(tool)), 'deny', `${tool} 在 plan 模式必须被拒绝`);
  }
});

test('plan 模式：白名单外的新工具默认拒绝（防遗漏放行）', async () => {
  const plan = new PlanApproval();
  assert.strictEqual(await plan.decide(req('future_mutation_tool')), 'deny');
});

test('plan 模式：extraAllowedTools 可扩展白名单', async () => {
  const plan = new PlanApproval({ extraAllowedTools: ['my_readonly_tool'] });
  assert.strictEqual(await plan.decide(req('my_readonly_tool')), 'allow');
  assert.strictEqual(await plan.decide(req('shell')), 'deny');
});
