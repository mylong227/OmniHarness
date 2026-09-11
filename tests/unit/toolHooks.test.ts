import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolHookRunner } from '../../src/core/toolHookRunner.js';
import type { ToolHookContext, ToolHooks } from '../../src/core/toolHookRunner.js';
import type { ToolResult } from '../../src/ports/tool.js';

/** 上下文。 */
const context: ToolHookContext = { sessionId: 's1', toolName: 'shell', target: 'ls' };

test('钩子：pre 依序执行，post 逆序执行', async () => {
  const runner = new ToolHookRunner();
  const log: string[] = [];
  const make = (name: string): ToolHooks => ({
    pre: () => {
      log.push(`pre:${name}`);
    },
    post: (_ctx: ToolHookContext, _result: ToolResult) => {
      log.push(`post:${name}`);
    },
  });
  runner.add(make('a'));
  runner.add(make('b'));

  await runner.pre(context);
  await runner.post(context, { callId: 'c1', ok: true, output: 'x' });
  assert.deepStrictEqual(log, ['pre:a', 'pre:b', 'post:b', 'post:a']);
});

test('钩子：空运行器不抛错', async () => {
  const runner = new ToolHookRunner();
  await runner.pre(context);
  await runner.post(context, { callId: 'c1', ok: true });
  assert.ok(true);
});

test('钩子：只注册 pre 时 post 无副作用', async () => {
  const runner = new ToolHookRunner();
  runner.add({ pre: () => undefined });
  await runner.post(context, { callId: 'c1', ok: false, error: 'x' });
  assert.ok(true);
});
