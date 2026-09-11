// Agent loop 审计回归测试（2026-09-08）。
//
// 背景：连续多轮「模型 400 / 无结果 / 疑似死循环」的表象修复后，对主循环做一次
// 结构性体检。本文件把审计发现的缺陷逐个做成**可执行断言**（先红后绿）：
//  A. resume 会话本轮无输出时，finalText 串到上一轮历史答案（静默错误答案）；
//  B. 模型返回空输出（既无文本也无工具调用）时回合一步即终止，无重试、无兜底；
//  C. native（FFI）路径下 pre 钩子在工具**执行之后**才跑，失去拦截/审计语义；
//  D. 模型抛异常时整个回合的事件不落盘，会话历史丢失。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Agent } from '../../src/core/agent.js';
import { createRuntime } from '../../src/core/runtime.js';
import { ConfigFactory } from '../../src/config/configFactory.js';
import { MockModel } from '../../src/adapters/model/mockModel.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import { StepRunner } from '../../src/core/stepRunner.js';
import { TurnRunner } from '../../src/core/turnRunner.js';
import { SessionRecorder } from '../../src/core/sessionRecorder.js';
import { AppendOnlyEventLog } from '../../src/core/appendOnlyEventLog.js';
import { ToolHookRunner } from '../../src/core/toolHookRunner.js';
import type { ModelPort, ModelOutput, ModelRequest } from '../../src/ports/model.js';
import type { ApprovalPort } from '../../src/ports/approval.js';
import type { SandboxPort } from '../../src/ports/sandbox.js';
import type { ToolCall, ToolPort } from '../../src/ports/tool.js';
import type { StoragePort } from '../../src/ports/storage.js';

// 关掉 repo-map 注入：本文件只审计主循环控制流，不希望索引整个仓库（慢且与断言无关）。
// node:test 每个测试文件独立进程，此处设置不会污染其它套件。
process.env.OMNI_REPO_MAP = '0';

/** 审计专用空工作区（避免 AGENTS.md / repo-map 等外部输入干扰控制流断言）。 */
const WS_ROOT = await mkdtemp(join(tmpdir(), 'omni-audit-'));

/** 构造 Agent（内存存储，模型可注入）。 */
function buildAgent(storage: StoragePort, model: ModelPort, maxSteps = 4): Agent {
  const config = ConfigFactory.build({
    workspaceRoot: WS_ROOT,
    maxSteps,
    model,
    storage,
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
  });
  return new Agent(createRuntime(config));
}

const allowApproval: ApprovalPort = { name: 'allow', decide: async () => 'allow' };
const sandboxOk: SandboxPort = { name: 'ok', check: async () => ({ allowed: true }) };
const toolsStub: ToolPort = {
  name: 'stub',
  list: () => [
    { name: 'shell.run', description: 'run shell', parameters: { type: 'object', properties: {} } },
  ],
  execute: async (c) => ({ callId: c.id, ok: true, output: 'ok' }),
};

function recorderFor(sid: string): SessionRecorder {
  return new SessionRecorder(new AppendOnlyEventLog(), new SilentEventPort(), sid);
}

/** 恒返回空输出的模型（既无 text 也无 toolCalls）。 */
const emptyModel: ModelPort = {
  name: 'empty',
  generate: async (req: ModelRequest): Promise<ModelOutput> =>
    req.tools.length === 0 ? { text: '【兜底总结】' } : {},
};

// ─────────────────────────────────────────────────────────────────────────────
// A. resume 污染：本轮无输出却返回上一轮答案
// ─────────────────────────────────────────────────────────────────────────────
test('A. resume 会话本轮无输出时，finalText 不得串到上一轮历史答案', async () => {
  const storage = new MemoryStorage();
  const first = await buildAgent(storage, new MockModel()).runTask('第一次任务');
  assert.ok(first.finalText !== undefined && first.finalText !== '', '首轮应有文本');

  // 第二轮模型空转（不产文本、不调工具）。
  const second = await buildAgent(storage, emptyModel, 4).resume(first.sessionId, '继续做');

  assert.notEqual(
    second.finalText,
    first.finalText,
    'BUG：本轮未产出任何内容，finalText 却返回了上一轮的历史答案（静默错误答案）',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// B. 空输出（empty）一步即终止
// ─────────────────────────────────────────────────────────────────────────────
test('B. 模型持续空输出时，应重试/兜底而非一步即终止', async () => {
  const recorder = recorderFor('s-audit-b');
  const sr = new StepRunner({
    model: emptyModel,
    tools: toolsStub,
    approvals: allowApproval,
    sandbox: sandboxOk,
    recorder,
    sessionId: 's-audit-b',
  });
  const tr = new TurnRunner(sr, recorder, 3);
  const outcome = await tr.run({ sessionId: 's-audit-b', workspaceRoot: '/tmp' });

  assert.ok(
    outcome.finalText !== undefined && outcome.finalText !== '',
    `BUG：模型连续空输出时回合一步即终止且无兜底，finalText=${String(outcome.finalText)}`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// C. native 路径 pre 钩子顺序
// ─────────────────────────────────────────────────────────────────────────────
test('C. native（FFI）路径：pre 钩子必须先于工具执行', async () => {
  const order: string[] = [];
  const recorder = recorderFor('s-audit-c');
  const hooks = new ToolHookRunner();
  hooks.add({ pre: () => void order.push('pre') });

  let calls = 0;
  const model: ModelPort = {
    name: 'mock',
    generate: async (): Promise<ModelOutput> => {
      calls += 1;
      return calls === 1
        ? { toolCalls: [{ id: 'c1', name: 'shell.run', arguments: {} }] }
        : { text: '完成' };
    },
  };
  const native = {
    runTool: (call: ToolCall) => {
      order.push('exec');
      return { callId: call.id, ok: true, output: 'native-out' };
    },
  };
  const sr = new StepRunner({
    model,
    tools: toolsStub,
    approvals: allowApproval,
    sandbox: sandboxOk,
    recorder,
    sessionId: 's-audit-c',
    hooks,
    native,
  });
  await new TurnRunner(sr, recorder, 4).run({ sessionId: 's-audit-c', workspaceRoot: '/tmp' });

  assert.deepEqual(
    order,
    ['pre', 'exec'],
    'BUG：native 路径先执行工具再跑 pre 钩子，pre 已无法拦截/审计',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// D. 模型异常时的事件持久化
// ─────────────────────────────────────────────────────────────────────────────
test('D. 模型抛异常时，已产生的事件仍应落盘（不丢会话历史）', async () => {
  const inner = new MemoryStorage();
  let saveCalls = 0;
  let savedCount = 0;
  // 代理存储：统计异常路径下是否仍发生持久化。
  const spy: StoragePort = {
    name: 'spy',
    save: async (sid, evs) => {
      saveCalls += 1;
      savedCount = evs.length;
      await inner.save(sid, evs);
    },
    load: (sid) => inner.load(sid),
  };
  const boom: ModelPort = {
    name: 'boom',
    generate: async (): Promise<ModelOutput> => {
      throw new Error('上游模型 500');
    },
  };
  const agent = buildAgent(spy, boom, 4);

  let threw = false;
  try {
    await agent.runTask('会炸的任务');
  } catch {
    threw = true;
  }

  assert.ok(threw, '模型异常应向上抛出（由调用方决定重试/上报）');
  assert.ok(
    saveCalls > 0 && savedCount > 0,
    'BUG：模型异常导致事件一条都没持久化，用户重进会话历史全丢',
  );
});
