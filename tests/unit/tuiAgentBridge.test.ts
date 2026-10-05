/**
 * TUI ↔ Agent 桥单测：多轮衔接（runTask → resume）、错误路径收成 error 事件、
 * 真实装配下的事件映射（tool_call / tool_result / assistant 全走到、user 事件不渲染）。
 *
 * 判据钉法：映射断言钉 MockModel 的**字面量脚本**（工具名 shell、最终文本
 * 「任务完成（模拟模型适配器输出）」）——模型脚本变了必须同时更新此处，防止映射静默漂移。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '../../src/core/agent.js';
import { ConfigFactory } from '../../src/config/configFactory.js';
import { Runtime } from '../../src/composition/runtime.js';
import { MockModel } from '../../src/adapters/model/mockModel.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import { TuiAgentBridge } from '../../src/tui/tuiAgentBridge.js';
import type { TuiEvent } from '../../src/tui/tuiRenderer.js';
import type { TuiTaskRunner } from '../../src/ports/tui/tuiTaskRunner.js';
import { TOOL_NAMES } from '../../src/ports/tool/toolNames.js';

/** 收尽一个事件流。 */
async function drain(it: AsyncIterable<TuiEvent>): Promise<TuiEvent[]> {
  const out: TuiEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

test('多轮衔接：首轮 runTask，后续 resume 同一 sessionId', async () => {
  const calls: string[] = [];
  const runner: TuiTaskRunner = {
    runTask: async (prompt: string) => {
      calls.push(`runTask:${prompt}`);
      return { sessionId: 'sess-1' };
    },
    resume: async (sessionId: string, prompt: string) => {
      calls.push(`resume:${sessionId}:${prompt}`);
      return { sessionId };
    },
  };
  const bridge = new TuiAgentBridge();
  bridge.attach(runner);
  assert.strictEqual(bridge.currentSessionId, undefined);
  assert.deepStrictEqual(await drain(bridge.send('第一轮')), []);
  assert.strictEqual(bridge.currentSessionId, 'sess-1');
  await drain(bridge.send('第二轮'));
  assert.deepStrictEqual(calls, ['runTask:第一轮', 'resume:sess-1:第二轮']);
});

test('错误路径：任务抛错被收成一条 error 事件，交互循环不炸', async () => {
  const runner: TuiTaskRunner = {
    runTask: async () => {
      throw new Error('boom');
    },
    resume: async (sessionId: string) => ({ sessionId }),
  };
  const bridge = new TuiAgentBridge();
  bridge.attach(runner);
  const events = await drain(bridge.send('会炸'));
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0]?.kind, 'error');
  assert.strictEqual(events[0]?.text, 'boom');
  assert.strictEqual(bridge.currentSessionId, undefined);
});

test('未 attach 即 send 属编程错误（不留静默回声）', async () => {
  const bridge = new TuiAgentBridge();
  await assert.rejects(() => drain(bridge.send('x')), Error);
});

test('真实装配（MockModel）：事件映射全走到、user 事件不渲染、会话 ID 稳定', async () => {
  const bridge = new TuiAgentBridge();
  const dir = mkdtempSync(join(tmpdir(), 'omni-tui-bridge-'));
  const config = ConfigFactory.build({
    workspaceRoot: dir,
    maxSteps: 3,
    model: new MockModel(),
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: bridge.port(),
  });
  const agent = new Agent(Runtime.createRuntime(config));
  bridge.attach(agent);
  const events = await drain(bridge.send('echo 一下'));
  const kinds = new Set(events.map((ev) => ev.kind));
  assert.ok(kinds.has('tool_call'), `缺 tool_call：${JSON.stringify(kinds)}`);
  assert.ok(kinds.has('tool_result'), `缺 tool_result：${JSON.stringify(kinds)}`);
  assert.ok(kinds.has('assistant'), `缺 assistant：${JSON.stringify(kinds)}`);
  // user 事件（用户刚输入的内容）不应被桥重复渲染为任何行。
  assert.ok(
    events.every((ev) => ev.text !== 'echo 一下'),
    '用户输入原文不应作为事件回显',
  );
  const call = events.find((ev) => ev.kind === 'tool_call');
  assert.strictEqual(call?.text, TOOL_NAMES.shell);
  const final = events.filter((ev) => ev.kind === 'assistant').at(-1);
  assert.ok(
    final?.text.includes('任务完成（模拟模型适配器输出）'),
    `末条 assistant=${final?.text}`,
  );
  const sessionId = bridge.currentSessionId;
  assert.ok(sessionId !== undefined && sessionId !== '');
  // 多轮：第二次 send 走 resume（同一会话），事件流继续产出。
  const second = await drain(bridge.send('再来一次'));
  assert.ok(second.some((ev) => ev.kind === 'assistant'));
  assert.strictEqual(bridge.currentSessionId, sessionId, 'TUI 会话应保持同一 sessionId');
});
