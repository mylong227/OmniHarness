import { RepoMapContextEngine } from '../../src/context/repoMapContextEngine.js';
// #OBS-9：步数耗尽兜底回归测试。
//
// 复现场景（2026-09-08 真机）：模型持续调用工具（探索/检索）而从不输出文本，
// 跑满 maxSteps 后 TurnRunner 退出，finalText 为 undefined，用户侧表现为
// 「UI 转了很久、最后没有任何结果」（session.end steps=16 hasText:false）。
//
// 本测试锁定两件事：
//  1. StepRunner.finalize() 在 tools 为空时能让模型产出文本并入事件流；
//  2. TurnRunner 仅在「跑满 maxSteps 且无文本」时触发兜底，正常结束不多调一次模型。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { StepRunner } from '../../src/core/stepRunner.js';
import { TurnRunner } from '../../src/core/turnRunner.js';
import { SessionRecorder } from '../../src/core/sessionRecorder.js';
import { AppendOnlyEventLog } from '../../src/core/appendOnlyEventLog.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';
import type {
  ModelPort,
  ModelOutput,
  ModelRequest,
  ModelToolCallRef,
} from '../../src/ports/model.js';
import type { ToolPort } from '../../src/ports/tool.js';
import type { ApprovalPort } from '../../src/ports/approval.js';
import type { SandboxPort } from '../../src/ports/sandbox.js';

function recorderFor(sessionId: string): SessionRecorder {
  return new SessionRecorder(new AppendOnlyEventLog(), new SilentEventPort(), sessionId);
}

const allowApproval: ApprovalPort = { name: 'allow', decide: async () => 'allow' };
const sandboxOk: SandboxPort = { name: 'ok', check: async () => ({ allowed: true }) };
const jsTools: ToolPort = {
  name: 'js',
  // 必须列出至少一个工具：StepRunner.effectiveTools() 为空时，正常步与兜底步无法区分。
  list: () => [
    { name: 'shell.run', description: 'run shell', parameters: { type: 'object', properties: {} } },
  ],
  execute: async (c) => ({ callId: c.id, ok: true, output: 'ok' }),
};

/** 统计每次请求的工具数，供断言「兜底调用确实无工具」。 */
function makeModel(opts: { alwaysTool: boolean }): {
  model: ModelPort;
  toolCounts: number[];
  generateCalls: () => number;
} {
  const toolCounts: number[] = [];
  let calls = 0;
  let n = 0;
  const model: ModelPort = {
    name: 'mock',
    generate: async (req: ModelRequest): Promise<ModelOutput> => {
      calls += 1;
      toolCounts.push(req.tools.length);
      // 无工具 → 兜底总结场景：必须输出文本
      if (req.tools.length === 0) {
        return { text: '【兜底总结】基于已获得信息，结论如下。' };
      }
      const id = `call_${n++}`;
      const call: ModelToolCallRef = { id, name: 'shell.run', arguments: { command: 'echo hi' } };
      if (opts.alwaysTool) return { toolCalls: [call] };
      // 第二步产出文本（模拟正常收敛）
      return calls >= 2 ? { text: '正常完成。' } : { toolCalls: [call] };
    },
  };
  return { model, toolCounts, generateCalls: () => calls };
}

test('① 模型一直调工具：跑满 maxSteps 后兜底产出总结（不再 hasText:false）', async () => {
  const recorder = recorderFor('s-obs9-1');
  const { model, toolCounts } = makeModel({ alwaysTool: true });
  const sr = new StepRunner({
    model,
    tools: jsTools,
    approvals: allowApproval,
    sandbox: sandboxOk,
    repoMapContext: new RepoMapContextEngine(),
    recorder,
    sessionId: 's-obs9-1',
  });
  const tr = new TurnRunner(sr, recorder, 3);
  const outcome = await tr.run({ sessionId: 's-obs9-1', workspaceRoot: '/tmp' });

  assert.equal(outcome.steps, 3, '应跑满 3 步');
  assert.ok(
    outcome.finalText !== undefined && outcome.finalText.includes('兜底总结'),
    `兜底总结应产出文本，实际=${String(outcome.finalText)}`,
  );
  // 前 3 次带工具，第 4 次（兜底）必须无工具
  assert.equal(toolCounts.length, 4, '应为 3 步 + 1 次兜底调用');
  assert.equal(toolCounts[3], 0, '兜底调用必须传空工具集（否则模型会继续调工具）');
  assert.ok(
    recorder.allEvents().some((e) => e.type === 'assistant'),
    '兜底文本应写入事件流，UI 才能显示',
  );
});

test('② 模型正常收敛：不触发兜底，不额外多调一次模型', async () => {
  const recorder = recorderFor('s-obs9-2');
  const { model, toolCounts, generateCalls } = makeModel({ alwaysTool: false });
  const sr = new StepRunner({
    model,
    tools: jsTools,
    approvals: allowApproval,
    sandbox: sandboxOk,
    repoMapContext: new RepoMapContextEngine(),
    recorder,
    sessionId: 's-obs9-2',
  });
  const tr = new TurnRunner(sr, recorder, 8);
  const outcome = await tr.run({ sessionId: 's-obs9-2', workspaceRoot: '/tmp' });

  assert.equal(outcome.steps, 2, '第 2 步产出文本即结束');
  assert.equal(outcome.finalText, '正常完成。');
  assert.equal(generateCalls(), 2, '正常收敛时不应多调一次模型');
  assert.ok(
    toolCounts.every((c) => c > 0),
    '正常路径每次都应带工具集',
  );
});

test('③ 兜底调用失败时 fail-closed：不抛错、不阻断主流程', async () => {
  const recorder = recorderFor('s-obs9-3');
  let calls = 0;
  const model: ModelPort = {
    name: 'mock',
    generate: async (req: ModelRequest): Promise<ModelOutput> => {
      calls += 1;
      if (req.tools.length === 0) throw new Error('模型端点故障');
      return { toolCalls: [{ id: `c${calls}`, name: 'shell.run', arguments: {} }] };
    },
  };
  const sr = new StepRunner({
    model,
    tools: jsTools,
    approvals: allowApproval,
    sandbox: sandboxOk,
    repoMapContext: new RepoMapContextEngine(),
    recorder,
    sessionId: 's-obs9-3',
  });
  const tr = new TurnRunner(sr, recorder, 2);
  const outcome = await tr.run({ sessionId: 's-obs9-3', workspaceRoot: '/tmp' });

  assert.equal(outcome.steps, 2, '步数照常统计');
  assert.equal(outcome.finalText, undefined, '兜底失败时 finalText 保持 undefined，不臆造内容');
});
