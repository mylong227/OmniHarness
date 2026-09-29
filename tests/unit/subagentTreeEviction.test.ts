// 子智能体编排器：父子关系表上限淘汰（审计 §30 Gap ⑤）单元测试。
// 覆盖：link 累积超过 MAX_TREE_ENTRIES(4096) 后淘汰最旧条目，避免跨长时进程无界增长。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SubagentOrchestrator } from '../../src/subagent/subagentOrchestrator.js';
import type { SubagentPortsShape } from '../../src/subagent/subagentPorts.js';

/** 读取 private static 上限（避免测试与实现常量漂移）。 */
function maxTreeEntries(): number {
  return (SubagentOrchestrator as unknown as { MAX_TREE_ENTRIES: number }).MAX_TREE_ENTRIES;
}

/** 调用 private link（仅做关系记录，不触发真实子代理运行）。 */
function link(
  orch: SubagentOrchestrator,
  parent: string,
  child: string,
): void {
  (orch as unknown as { link(p: string, c: string): void }).link(parent, child);
}

test('link：父子关系表超过上限后淘汰最旧条目（无界增长防御）', () => {
  const orch = new SubagentOrchestrator({} as unknown as SubagentPortsShape, {});
  const cap = maxTreeEntries();
  assert.ok(cap > 0, '上限应为正数');
  // 插入 cap+1 条不同父会话的关系，触发一次最旧淘汰。
  const total = cap + 1;
  for (let i = 0; i < total; i += 1) {
    link(orch, `parent-${i}`, `child-${i}`);
  }
  // 最旧一条（parent-0）应已被淘汰。
  assert.deepStrictEqual(orch.childrenOf('parent-0'), [], '最旧条目应被淘汰');
  // 最新一条应保留。
  assert.deepStrictEqual(orch.childrenOf(`parent-${cap}`), [`child-${cap}`], '最新条目应保留');
});

test('link：同一父会话累积多个子会话', () => {
  const orch = new SubagentOrchestrator({} as unknown as SubagentPortsShape, {});
  link(orch, 'p', 'a');
  link(orch, 'p', 'b');
  assert.deepStrictEqual(orch.childrenOf('p'), ['a', 'b']);
});
