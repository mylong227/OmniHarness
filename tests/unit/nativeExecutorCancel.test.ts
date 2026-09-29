// 原生执行器取消传播（审计 §30 Gap ⑧）单元测试。
// 覆盖：run 在收到已触发 AbortSignal 时 fail-closed 直接记取消（envError），不静默忽略信号继续烧资源。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NativeExecutor } from '../../src/eval/nativeExecutor.js';
import type { VerifiedTask } from '../../src/eval/swebenchVerified.js';

/** 构造最小合法任务（FAIL_TO_PASS 非空，才能越过 fail-open 防线进入信号检查）。 */
function task(): VerifiedTask {
  return {
    id: 'inst-cancel',
    repo: 'django/django',
    baseCommit: 'abc123',
    problemStatement: '修复',
    goldPatch: '',
    testPatch: '',
    failToPass: ['test_x::test_a'],
    passToPass: [],
    version: '',
  };
}

test('run：已触发 AbortSignal → fail-closed 记取消（envError，不消耗 git/uv）', async () => {
  const ex = new NativeExecutor({});
  const ac = new AbortController();
  ac.abort();
  const result = await ex.run(task(), 'model patch', ac.signal);
  assert.strictEqual(result.resolved, false);
  assert.strictEqual(result.envError, true, '取消属设施层中断，应标 envError 不计入 resolved 分母');
  assert.match(result.reason ?? '', /取消/);
});
