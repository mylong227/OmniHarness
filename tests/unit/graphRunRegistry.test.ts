/**
 * GraphRunRegistry 淘汰（对应全项目审计发现的「淘汰不中止后台运行」缺口）。
 *
 * 修复前超出 `MAX_RUNS` 时仅 `delete` 台账条目，被淘汰的 `WorkflowRunner` 仍在后台烧 token/子进程；
 * 修复后淘汰最旧一条会先 `abort()` 其取消控制器。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphRunRegistry } from '../../src/server/core/graphRunRegistry.js';
import type { WorkflowDef } from '../../src/autonomy/workflowTypes.js';

/** 构造一个合法的最小工作流定义（单步）。 */
function sampleDef(): WorkflowDef {
  return { name: 'sample', steps: [{ id: 's1', prompt: 'p' }] };
}

test('GraphRunRegistry：超出上限淘汰最旧运行时，其取消信号必须被中止', () => {
  const reg = new GraphRunRegistry();
  const handles: { readonly runId: string; readonly signal: AbortSignal }[] = [];
  for (let i = 0; i < GraphRunRegistry.MAX_RUNS + 1; i++) {
    handles.push(reg.begin(sampleDef(), undefined, undefined));
  }
  // 最旧一条（handles[0]）应已被淘汰并 abort。
  const oldest = handles[0];
  assert.ok(oldest, '最旧运行必须存在');
  assert.strictEqual(oldest.signal.aborted, true, '最旧运行的取消信号必须被中止');
  // 最新一条仍在台账内，未被中止。
  const newest = handles[handles.length - 1];
  assert.ok(newest, '最新运行必须存在');
  assert.strictEqual(newest.signal.aborted, false);
});
