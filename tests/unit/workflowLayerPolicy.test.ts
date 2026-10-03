/**
 * 工作流同层并发策略的用例（2026-10-03 第六轮，对应看板 §8.1 的 S3）。
 *
 * 背景：工作流步骤**共享父工作区**（产出要供后续步骤使用），与 `SubagentOrchestrator` 的
 * worktree 隔离**语义相反**。于是同层多个"可能写文件"的步骤并发会互相覆盖同一文件且无冲突检测。
 * 本文件钉住"哪些层必须退化为串行"的判据（保守取向：宁可多串行几层）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WorkflowLayerPolicy } from '../../src/autonomy/workflowLayerPolicy.js';
import { TOOL_NAMES } from '../../src/ports/tool/toolNames.js';
import type { WorkflowStep } from '../../src/ports/autonomy/workflowStep.js';

/**
 * 造一个最小步骤。
 * @param id 步骤 id。
 * @param tools 显式工具白名单（不传＝未声明，视为要全集）。
 * @returns 工作流步骤。
 */
const step = (id: string, tools?: readonly string[]): WorkflowStep => ({
  id,
  prompt: `做 ${id}`,
  ...(tools !== undefined ? { tools } : {}),
});

test('① 单步层：串行与并发等价 ⇒ 不触发串行退化', () => {
  assert.strictEqual(
    WorkflowLayerPolicy.shouldSerialize([step('a', [TOOL_NAMES.writeFile])]),
    false,
  );
  assert.strictEqual(WorkflowLayerPolicy.shouldSerialize([step('a')]), false);
});

test('② 同层两步都显式只读 ⇒ 保持并发（不要把只读层也串行化）', () => {
  const layer = [step('a', [TOOL_NAMES.readFile, TOOL_NAMES.grep]), step('b', [TOOL_NAMES.glob])];
  assert.strictEqual(WorkflowLayerPolicy.shouldSerialize(layer), false);
});

test('③ 同层有一步**未声明 tools**（＝拿到全集，可能写）⇒ 必须串行', () => {
  const layer = [step('a', [TOOL_NAMES.readFile]), step('b')];
  assert.strictEqual(WorkflowLayerPolicy.mayWrite(layer[1]!), true);
  assert.strictEqual(WorkflowLayerPolicy.shouldSerialize(layer), true);
});

test('④ 同层有一步显式含写类工具 ⇒ 必须串行（并发会互相覆盖同一文件）', () => {
  const layer = [
    step('a', [TOOL_NAMES.readFile, TOOL_NAMES.writeFile]),
    step('b', [TOOL_NAMES.readFile]),
  ];
  assert.strictEqual(WorkflowLayerPolicy.shouldSerialize(layer), true);
  for (const name of [TOOL_NAMES.applyPatch, TOOL_NAMES.shell, TOOL_NAMES.rollback]) {
    assert.strictEqual(
      WorkflowLayerPolicy.mayWrite(step('x', [name])),
      true,
      `${name} 必须算可能写`,
    );
  }
});

test('⑤ mayWrite 三态：未声明 ⇒ 可能写；显式只读 ⇒ 不可能写；显式含写 ⇒ 可能写', () => {
  assert.strictEqual(WorkflowLayerPolicy.mayWrite(step('a')), true);
  assert.strictEqual(WorkflowLayerPolicy.mayWrite(step('a', [TOOL_NAMES.grep])), false);
  assert.strictEqual(
    WorkflowLayerPolicy.mayWrite(step('a', [TOOL_NAMES.grep, TOOL_NAMES.edit])),
    true,
  );
});
