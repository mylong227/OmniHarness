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

test('GraphRunRegistry：同一 runId 的在飞运行不许被第二次续跑覆盖（fail-closed）', () => {
  const reg = new GraphRunRegistry();
  const first = reg.begin(sampleDef(), undefined, undefined, 'run_reuse_1');
  assert.strictEqual(first.runId, 'run_reuse_1', '续跑必须沿用同一个 runId');

  // 还没 release（仍在飞）就再续一次：必须拒绝——否则 runs/aborts 被覆盖 ⇒ 取消句柄丢失，
  // 且两个 runner 会并发追加同一份运行日志（行交错，存档不可信）。
  assert.throws(() => reg.begin(sampleDef(), undefined, undefined, 'run_reuse_1'), /正在续跑中/);
  assert.strictEqual(reg.get('run_reuse_1')?.done, false, '被拒绝的请求不得改动既有台账');

  // 释放（= 该运行已结束）后允许再次续跑。
  reg.release('run_reuse_1');
  const second = reg.begin(sampleDef(), undefined, undefined, 'run_reuse_1');
  assert.strictEqual(second.runId, 'run_reuse_1');
  assert.strictEqual(second.signal.aborted, false);
});
