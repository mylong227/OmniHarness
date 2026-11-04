/**
 * MRTR live handler 组合器判据（2026-11-04 覆盖率四站补测之一，原 0%）。
 *
 * 钉死的口径：**按注册顺序评估、第一个非 allow 裁决获胜并短路、全 allow / 空列表 ⇒ allow**
 * （`mcp serve` 可同时挂 ask_user 与审批 handler 而互不覆盖的前提）。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { McpCompositeInputHandler } from '../../src/protocols/mcp/mcpCompositeInputHandler.ts';
import type { McpInputRequiredPort } from '../../src/contracts/ports/mcp/mcpInputRequiredPort.ts';
import type { ToolCall } from '../../src/contracts/ports/tool/tool.ts';

/** 最小上下文（组合器只透传，不解释字段）。 */
function ctx(): Parameters<McpInputRequiredPort['evaluate']>[0] {
  return {
    call: { name: 'probe' } as unknown as ToolCall,
    sessionId: 's1',
    attempt: 0,
    clientCapabilities: {},
    modern: true,
  };
}

/**
 * 桩 handler：返回固定裁决并把调用记进流水（供顺序断言）。
 * @param name 端口名。
 * @param decision 固定裁决。
 * @param log 调用流水（可选）。
 * @returns 端口桩。
 */
function stub(
  name: string,
  decision: Awaited<ReturnType<McpInputRequiredPort['evaluate']>>,
  log?: string[],
): McpInputRequiredPort {
  return {
    name,
    evaluate: async () => {
      log?.push(name);
      return decision;
    },
  };
}

test('① 全 allow ⇒ allow，且按注册顺序逐个评估', async () => {
  const log: string[] = [];
  const composite = new McpCompositeInputHandler([
    stub('a', { kind: 'allow' }, log),
    stub('b', { kind: 'allow' }, log),
  ]);
  assert.deepStrictEqual(await composite.evaluate(ctx()), { kind: 'allow' });
  assert.deepStrictEqual(log, ['a', 'b'], '必须按注册顺序评估');
});

test('② 第一个非 allow 获胜并短路（后续 handler 不再被调用）', async () => {
  const log: string[] = [];
  const composite = new McpCompositeInputHandler([
    stub('a', { kind: 'allow' }, log),
    stub('b', { kind: 'deny', message: '审批拒绝' }, log),
    stub('c', { kind: 'deny', message: '不该被问到' }, log),
  ]);
  assert.deepStrictEqual(await composite.evaluate(ctx()), { kind: 'deny', message: '审批拒绝' });
  assert.deepStrictEqual(log, ['a', 'b'], 'b 获胜后 c 不得被评估');
});

test('③ 三种非 allow 裁决原样透传（respond / input_required / deny）', async () => {
  const respond = new McpCompositeInputHandler([
    stub('a', { kind: 'respond', output: '用户回答', isError: false }),
  ]);
  assert.deepStrictEqual(await respond.evaluate(ctx()), {
    kind: 'respond',
    output: '用户回答',
    isError: false,
  });
  const required = new McpCompositeInputHandler([
    stub('a', { kind: 'input_required', inputRequests: {}, reason: '需要补充' }),
  ]);
  assert.deepStrictEqual(await required.evaluate(ctx()), {
    kind: 'input_required',
    inputRequests: {},
    reason: '需要补充',
  });
  const deny = new McpCompositeInputHandler([stub('a', { kind: 'deny', message: 'x' })]);
  assert.deepStrictEqual(await deny.evaluate(ctx()), { kind: 'deny', message: 'x' });
});

test('④ 空列表 ⇒ allow（构造器口径：等价于「不产生 input_required」）', async () => {
  const composite = new McpCompositeInputHandler([]);
  assert.deepStrictEqual(await composite.evaluate(ctx()), { kind: 'allow' });
});
