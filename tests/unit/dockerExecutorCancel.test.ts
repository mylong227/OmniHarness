// Docker 执行器（审计 §30 Gap ⑧）fail-closed 单元测试。
// 覆盖：docker CLI 不可用时 fail-closed 记 envError（不静默假绿）；run 接受 signal 参数且不抛错。
//
// 注：信号在「容器内」的传播路径（runContainer 内超时/取消触发 docker kill 清理孤儿容器）
// 需要真实 docker daemon，本沙箱无 docker，故不在单测里执行；该路径由 typecheck 守型 +
// evals/e2e-native-gitee-smoke 端到端覆盖。本文件只验证「signal 参数被接受、fail-closed 路径稳定」。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DockerExecutor } from '../../src/eval/dockerExecutor.js';
import type { VerifiedTask } from '../../src/eval/swebenchVerified.js';

/** 构造最小合法任务（仓库需登记在官方 pytest 仓库集合内，FAIL_TO_PASS 非空）。 */
function task(): VerifiedTask {
  return {
    id: 'astropy__astropy-1',
    repo: 'astropy/astropy',
    baseCommit: 'abc123',
    problemStatement: '修复',
    goldPatch: '',
    testPatch: '',
    failToPass: ['test_x::test_a'],
    passToPass: [],
    version: '',
  };
}

test('run：docker CLI 不可用 → fail-closed 记 envError（不静默回落/假绿）', async () => {
  const ex = new DockerExecutor({ dockerCli: '/nonexistent/omni-docker-bin' });
  const result = await ex.run(task(), 'model patch');
  assert.strictEqual(result.resolved, false);
  assert.strictEqual(result.envError, true, 'docker 不可用属设施缺失，应标 envError');
  assert.match(result.reason ?? '', /docker CLI 不可用/);
});

test('run：传入 AbortSignal 不抛错（signal 参数被接受，仍走 fail-closed）', async () => {
  const ex = new DockerExecutor({ dockerCli: '/nonexistent/omni-docker-bin' });
  const ac = new AbortController();
  ac.abort();
  const result = await ex.run(task(), 'model patch', ac.signal);
  assert.strictEqual(result.resolved, false);
  assert.strictEqual(result.envError, true);
});
