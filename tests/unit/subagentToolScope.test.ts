/**
 * 子智能体工具面收窄的用例（2026-10-03 第六轮，对应看板 §8.1 的 S1）。
 *
 * 背景：子代理写入落在隔离工作树里，清理是 `worktree remove --force` + `branch -D`；
 * 在 **copy 降级档**（git 不可用/失败）下没有 git 可比 ⇒ 改动连 patch 都取不回来。
 * 该档唯一不制造"静默丢失"的做法是**禁写**（fail-closed）。本文件钉住收窄口径。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SubagentToolScope } from '../../src/subagent/subagentToolScope.js';
import { MUTATING_TOOLS } from '../../src/core/toolGate.js';
import { TOOL_NAMES } from '../../src/ports/tool/toolNames.js';
import type { SubagentRequest } from '../../src/subagent/subagentTypes.js';

/**
 * 造一个最小子任务请求。
 * @param tools 显式工具白名单（不传＝未声明，视为要全集）。
 * @returns 子任务请求。
 */
const request = (tools?: readonly string[]): SubagentRequest => ({
  task: '改点东西',
  parentSessionId: 'parent',
  depth: 1,
  ...(tools !== undefined ? { tools } : {}),
});

test('① 未声明 tools（要全集）⇒ 收窄后不含任何写类工具，只读工具仍在', () => {
  const available = [
    TOOL_NAMES.readFile,
    TOOL_NAMES.grep,
    TOOL_NAMES.writeFile,
    TOOL_NAMES.edit,
    TOOL_NAMES.applyPatch,
    TOOL_NAMES.shell,
  ];
  const scoped = SubagentToolScope.writeForbidden(request(), available);
  assert.ok(scoped.tools !== undefined, '必须显式给出工具列表（留空＝要全集，等于放回写类）');
  assert.ok(scoped.tools.includes(TOOL_NAMES.readFile), '只读工具必须保留');
  assert.ok(scoped.tools.includes(TOOL_NAMES.grep), '只读工具必须保留');
  assert.ok(!scoped.tools.includes(TOOL_NAMES.writeFile));
  assert.ok(!scoped.tools.includes(TOOL_NAMES.edit));
  assert.ok(!scoped.tools.includes(TOOL_NAMES.applyPatch));
  assert.ok(!scoped.tools.includes(TOOL_NAMES.shell), 'shell 能落盘 ⇒ 与写类同级');
  assert.ok(SubagentToolScope.hasNoWriters(scoped), '自检：收窄后确实一个写类都不剩');
});

test('② 显式声明含写类 ⇒ 只剔除写类，其余原样保留顺序', () => {
  const scoped = SubagentToolScope.writeForbidden(
    request([TOOL_NAMES.readFile, TOOL_NAMES.writeFile, TOOL_NAMES.grep, TOOL_NAMES.rollback]),
    [],
  );
  assert.deepStrictEqual(scoped.tools, [TOOL_NAMES.readFile, TOOL_NAMES.grep]);
});

test('③ 不改原请求（收窄必须返回新对象，避免影响并发派生的其他子代理）', () => {
  const original = request([TOOL_NAMES.writeFile]);
  const scoped = SubagentToolScope.writeForbidden(original, []);
  assert.deepStrictEqual(original.tools, [TOOL_NAMES.writeFile], '原请求不得被就地修改');
  assert.deepStrictEqual(scoped.tools, []);
  assert.notStrictEqual(scoped, original);
});

test('④ 写类清单本身必须非空且覆盖落盘/执行面（判据的护栏）', () => {
  for (const name of [
    TOOL_NAMES.writeFile,
    TOOL_NAMES.edit,
    TOOL_NAMES.applyPatch,
    TOOL_NAMES.shell,
    TOOL_NAMES.rollback,
  ]) {
    assert.ok(MUTATING_TOOLS.has(name), `${name} 必须算写类（漏收即等于放行）`);
  }
  assert.ok(MUTATING_TOOLS.size >= 8, `写类清单过小：${String(MUTATING_TOOLS.size)}`);
});
