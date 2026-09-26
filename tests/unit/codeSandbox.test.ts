/**
 * `run_code` 沙箱化的两条硬保证（2026-09-26 审计 S3）。
 *
 * 缺陷现场：解释器原先在主线程 `new Function(...)` 执行模型写的代码 —— 一句 `while(true){}`
 * 就把事件循环永久占住，**超时定时器与取消令牌跑在同一条被占住的循环上，谁也救不回来**
 * （旧 JSDoc 宣称的「可选超时」在依赖里根本不存在）。
 *
 * 本用例钉住：
 *  1. 正常程序照常工作，`call` 与 `log` 桥接不丢；
 *  2. **死循环被执行器有界中止**（到期 terminate Worker），且如实回报超时。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CodeInterpreter } from '../../src/adapters/tool/code/codeInterpreter.js';
import type { ToolCall } from '../../src/ports/tool/tool.js';

/** 构造只认 `echo` 的 execute 后端（记录收到的调用）。 */
function echoBackend(seen: ToolCall[]) {
  return async (call: ToolCall) => {
    seen.push(call);
    return { callId: call.id, ok: true, output: `echo:${String(call.arguments['text'] ?? '')}` };
  };
}

test('S3：正常程序在沙箱里跑通，call/log 桥接正确', async () => {
  const seen: ToolCall[] = [];
  const interpreter = new CodeInterpreter();
  const result = await interpreter.run(
    [
      'log("start");',
      'const out = await call("echo", { text: "hi" });',
      'log(out);',
      'return 42;',
    ].join('\n'),
    { execute: echoBackend(seen), timeoutMs: 10_000 },
  );
  assert.strictEqual(result.ok, true, `执行应成功，实际输出：${result.output}`);
  assert.match(result.output, /start/);
  assert.match(result.output, /echo:hi/, '工具返回必须桥回沙箱');
  assert.match(result.output, /返回值: 42/);
  assert.strictEqual(result.calls, 1);
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0]?.name, 'echo');
});

test('S3：死循环被有界中止（旧实现在主线程会永久挂住整个进程）', async () => {
  const interpreter = new CodeInterpreter();
  const started = Date.now();
  const result = await interpreter.run('while (true) {}', {
    execute: echoBackend([]),
    timeoutMs: 400,
  });
  const elapsed = Date.now() - started;
  assert.strictEqual(result.ok, false, '超时必须判失败');
  assert.match(result.output, /超时/, `应如实回报超时，实际：${result.output}`);
  assert.ok(elapsed < 10_000, `应有界中止，实际耗时 ${String(elapsed)}ms`);
});

test('S3：await 之后的死循环同样被中止（vm timeout 做不到这一点）', async () => {
  const interpreter = new CodeInterpreter();
  const result = await interpreter.run(
    'await new Promise((r) => setTimeout(r, 10));\nwhile (true) {}',
    { execute: echoBackend([]), timeoutMs: 400 },
  );
  assert.strictEqual(result.ok, false);
  assert.match(result.output, /超时/);
});

test('S3：工具失败在沙箱内表现为可捕获异常（不炸掉宿主）', async () => {
  const interpreter = new CodeInterpreter();
  const result = await interpreter.run(
    [
      'try {',
      '  await call("boom", {});',
      '} catch (e) {',
      '  log("caught: " + e.message);',
      '}',
    ].join('\n'),
    {
      execute: async (call) => ({ callId: call.id, ok: false, error: '炸了' }),
      timeoutMs: 10_000,
    },
  );
  assert.strictEqual(result.ok, true, `程序自身应正常结束，实际：${result.output}`);
  assert.match(result.output, /caught: 工具 boom 失败: 炸了/);
});

test('S3：非法超时回落默认（不把 NaN 透给定时器）', async () => {
  const interpreter = new CodeInterpreter();
  const result = await interpreter.run('return 1;', {
    execute: echoBackend([]),
    timeoutMs: Number.NaN,
  });
  assert.strictEqual(result.ok, true, '非法超时应回落默认而不是立刻超时');
});
