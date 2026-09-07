import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeKernel, NativeKernelUnavailableError } from '../../src/native/nativeKernel.js';

/**
 * #65 FFI 下沉：原生内核（N-API / .node）方法面测试。
 * .node 未构建时整体 skip（npm run native:build 后生效），保证 npm test 无外部依赖。
 *
 * 注意：改用 `test({ skip })` 真跳过，使 skip 可被统计——旧写法 `if (undefined) return`
 * 会让用例被记成「通过」而非「跳过」，虚增通过计数（静默假绿）。
 */
const kernelAvailable = new NativeKernel().available();
const skipWhenUnbuilt = kernelAvailable ? false : '内核未构建（npm run native:build）';

function loadKernel(): NativeKernel {
  return new NativeKernel();
}

test(
  'native kernel: 不可用时 fail-closed 抛错（不静默失败）',
  { skip: kernelAvailable ? '内核已构建，负路径由其余用例覆盖' : false },
  () => {
    const kernel = new NativeKernel();
    assert.throws(() => kernel.ping(), NativeKernelUnavailableError);
  },
);

test('native kernel: ping 往返', { skip: skipWhenUnbuilt }, () => {
  const kernel = loadKernel();
  const r = kernel.ping();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.pong, true);
  assert.strictEqual(r.native, true);
});

test('native kernel: tools.list 含 7 工具与 shell.run', { skip: skipWhenUnbuilt }, () => {
  const kernel = loadKernel();
  const tools = kernel.toolsList() as Array<{ name?: string }>;
  assert.strictEqual(tools.length, 7);
  assert.ok(tools.some((t) => t.name === 'shell.run'));
});

test('native kernel: approval.check 返回 allow 决策', { skip: skipWhenUnbuilt }, () => {
  const kernel = loadKernel();
  const decision = kernel.approvalCheck('shell.run', { command: 'echo hi' });
  assert.strictEqual(decision.decision, 'allow');
});

test('native kernel: session.submit 驱动状态机产出回合 op', { skip: skipWhenUnbuilt }, () => {
  const kernel = loadKernel();
  const ops = kernel.sessionSubmit({ kind: 'userInput', text: '你好' }) as Array<{ kind?: string }>;
  assert.ok(ops.some((op) => op.kind === 'turnStarted'));
  assert.ok(ops.some((op) => op.kind === 'turnCompleted'));
});

test('native kernel: context.render 返回 token 估算与渲染文本', { skip: skipWhenUnbuilt }, () => {
  const kernel = loadKernel();
  const r = kernel.contextRender();
  assert.strictEqual(typeof r.tokens, 'number');
  assert.strictEqual(typeof r.context, 'string');
});

test(
  'native kernel: toolCall 危险命令被策略沙箱拒绝（fail-closed）',
  { skip: skipWhenUnbuilt },
  () => {
    const kernel = loadKernel();
    const r = kernel.toolCall('shell.run', { command: 'rm -rf /tmp/x' }, 't-danger');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.rejected, true);
    assert.notStrictEqual(r.output, '');
  },
);

test('native kernel: 方法调用失败抛错（fail-closed）', { skip: skipWhenUnbuilt }, () => {
  const kernel = loadKernel();
  assert.throws(() => kernel.call('no.such.method'));
});
