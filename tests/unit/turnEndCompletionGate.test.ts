/**
 * 完成闸门**在未启用写时自验证时仍然生效**的回归（2026-09-26 审计 A1 收口）。
 *
 * 缺口：闸门原先只挂在写时自验证的产物（`SelfVerifyingToolPort.lastFailure`）上，
 * 于是「没开 `selfVerify`」的运行里，回合结束**没有任何东西**能核验模型是否真的改对了 ——
 * 等于回到旧行为。本次收口让闸门在那种配置下**自己跑一次**验证命令。
 *
 * 三条口径（都钉在用例里）：
 *  1. 未启用写时自验证 + 工作区有测试命令 ⇒ `turn-end` 闸门；**只在改过文件时**才跑；
 *  2. 显式 `selfVerify.enabled === false` ⇒ 两者皆无（尊重整体退出）；
 *  3. 命令跑不起来（工具链缺失等）⇒ fail-open，不拦收尾。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TurnCompletionGateFactory } from '../../src/adapters/tool/verify/turnCompletionGateFactory.js';
import { TurnEndCompletionGate } from '../../src/adapters/tool/verify/turnEndCompletionGate.js';
import { SelfVerifyPolicy } from '../../src/adapters/tool/verify/selfVerifyPolicy.js';
import { Runtime } from '../../src/composition/runtime.js';
import { ConfigFactory } from '../../src/config/configFactory.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';
import type { ModelPort } from '../../src/ports/model/model.js';
import type {
  TestCommandRunner,
  TestRunOutcome,
} from '../../src/adapters/tool/verify/testCommandRunner.js';
import type { ToolPort } from '../../src/ports/tool/tool.js';

/** 最小工具端口桩（不含 lastFailure ⇒ 走 turn-end 分支）。 */
const plainTools: ToolPort = {
  name: 'stub',
  list: () => [],
  execute: async (c) => ({ callId: c.id, ok: true }),
};

/** 造一个「有测试症状」的工作区（package.json 带 test 脚本 ⇒ 探测器可识别）。 */
function workspaceWithTests(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omni-gate-'));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'x', scripts: { test: 'node --test' } }),
    'utf8',
  );
  return dir;
}

test('A1 收口：未启用写时自验证也给出 turn-end 闸门（不再是旧行为）', () => {
  const dir = workspaceWithTests();
  try {
    const gate = TurnCompletionGateFactory.of({
      tools: plainTools,
      selfVerify: undefined,
      workspaceRoot: dir,
    });
    assert.ok(gate !== undefined, '未配置 selfVerify 时也应设闸门');
    assert.strictEqual(gate.kind, 'turn-end');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A1 收口：显式 selfVerify.enabled === false ⇒ 不设闸门（尊重整体退出）', () => {
  const dir = workspaceWithTests();
  try {
    const gate = TurnCompletionGateFactory.of({
      tools: plainTools,
      selfVerify: { enabled: false },
      workspaceRoot: dir,
    });
    assert.strictEqual(gate, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A1 收口：写时自验证已启用时优先读已有结论（status 型，零额外开销）', () => {
  const dir = workspaceWithTests();
  try {
    const tools = Object.assign(Object.create(null), plainTools, {
      lastFailure: () => '上次没过',
    }) as unknown as ToolPort;
    const gate = TurnCompletionGateFactory.of({
      tools,
      selfVerify: { enabled: true },
      workspaceRoot: dir,
    });
    assert.ok(gate !== undefined);
    assert.strictEqual(gate.kind, 'status', '有写时结论就不该再花一次全量测试');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A1 收口：探测不到测试命令 ⇒ 不设闸门（fail-closed，不臆造验证）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-gate-empty-'));
  try {
    const gate = TurnCompletionGateFactory.of({
      tools: plainTools,
      selfVerify: undefined,
      workspaceRoot: dir,
    });
    assert.strictEqual(gate, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 构造一个受控命令执行器桩。 */
function runnerStub(outcome: TestRunOutcome): { runner: TestCommandRunner; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    runner: {
      run: async (command: string): Promise<TestRunOutcome> => {
        calls.push(command);
        return outcome;
      },
    },
  };
}

test('A1 收口：turn-end 闸门跑真实命令，失败即产出带摘要的拦截文本', async () => {
  const { runner, calls } = runnerStub({
    exitCode: 1,
    output: 'FAIL src/a.test.ts\n  ● parser 应当分词\nAssertionError: expected 1 got 2',
    timedOut: false,
  });
  const gate = new TurnEndCompletionGate({
    policy: SelfVerifyPolicy.from({ command: 'npm test' }),
    workspaceRoot: process.cwd(),
    runner,
  });
  const digest = await gate.verify('s1');
  assert.deepStrictEqual(calls, ['npm test'], '应执行策略里的命令');
  assert.ok(digest !== undefined, '失败必须产出拦截文本');
  assert.match(digest, /回合结束验证未通过/);
  assert.match(digest, /parser 应当分词/, '摘要必须带上真实失败行');
});

test('A1 收口：验证通过时静默（不拦收尾）', async () => {
  const { runner } = runnerStub({ exitCode: 0, output: 'all pass', timedOut: false });
  const gate = new TurnEndCompletionGate({
    policy: SelfVerifyPolicy.from({ command: 'npm test' }),
    workspaceRoot: process.cwd(),
    runner,
  });
  assert.strictEqual(await gate.verify('s1'), undefined);
});

test('A1 收口：超时如实回报（不是静默通过）', async () => {
  const { runner } = runnerStub({ exitCode: null, output: '', timedOut: true });
  const gate = new TurnEndCompletionGate({
    policy: SelfVerifyPolicy.from({ command: 'npm test' }),
    workspaceRoot: process.cwd(),
    runner,
  });
  const digest = await gate.verify('s1');
  assert.ok(digest !== undefined);
  assert.match(digest, /超时/);
});

test('A1 收口：命令根本跑不起来 ⇒ fail-open（不拦收尾，闸门不是环境检测器）', async () => {
  const runner: TestCommandRunner = {
    run: async () => {
      throw new Error('spawn ENOENT');
    },
  };
  const gate = new TurnEndCompletionGate({
    policy: SelfVerifyPolicy.from({ command: 'npm test' }),
    workspaceRoot: process.cwd(),
    runner,
  });
  assert.strictEqual(await gate.verify('s1'), undefined);
});

test('第五轮：exit=0 但一条测试都没跑 ⇒ 必须拦截（零测试 ≠ 通过）', async () => {
  // 实测口径：`node --test "<落空的 glob>"` 打印 `# tests 0` 且 **exit = 0**。
  const { runner } = runnerStub({
    exitCode: 0,
    output: ['# tests 0', '# pass 0', '# fail 0', '# duration_ms 3'].join('\n'),
    timedOut: false,
  });
  const gate = new TurnEndCompletionGate({
    policy: SelfVerifyPolicy.from({ command: 'node --test "dist/tests/unit/*.test.js"' }),
    workspaceRoot: process.cwd(),
    runner,
  });
  const digest = await gate.verify('s1');
  assert.ok(digest !== undefined, '零测试必须被拦下（原判据这里会放行）');
  assert.match(digest, /一条测试都没跑/);
  assert.match(digest, /零测试 ≠ 通过/);
});

test('第五轮：exit=0 且确实跑了测试 ⇒ 放行（不要误杀正常通过）', async () => {
  const { runner } = runnerStub({
    exitCode: 0,
    output: ['# tests 12', '# pass 12', '# fail 0'].join('\n'),
    timedOut: false,
  });
  const gate = new TurnEndCompletionGate({
    policy: SelfVerifyPolicy.from({ command: 'node --test "dist/tests/unit/*.test.js"' }),
    workspaceRoot: process.cwd(),
    runner,
  });
  assert.strictEqual(await gate.verify('s1'), undefined);
});

test('第五轮：exit=0 但计数里有失败用例 ⇒ 以计数为准拦下（退出码与计数不一致）', async () => {
  const { runner } = runnerStub({
    exitCode: 0,
    output: ['# tests 5', '# pass 3', '# fail 2'].join('\n'),
    timedOut: false,
  });
  const gate = new TurnEndCompletionGate({
    policy: SelfVerifyPolicy.from({ command: 'node --test "dist/tests/unit/*.test.js"' }),
    workspaceRoot: process.cwd(),
    runner,
  });
  const digest = await gate.verify('s1');
  assert.ok(digest !== undefined);
  assert.match(digest, /2 个失败用例/);
});

test('第五轮：拿不到汇总行（日志被截断 / 非测试命令）⇒ 仍 fail-open，不拦收尾', async () => {
  const truncated = runnerStub({
    exitCode: 0,
    output: '（输出被上限截断，没有汇总行）',
    timedOut: false,
  });
  const gateA = new TurnEndCompletionGate({
    policy: SelfVerifyPolicy.from({ command: 'node --test "dist/tests/unit/*.test.js"' }),
    workspaceRoot: process.cwd(),
    runner: truncated.runner,
  });
  assert.strictEqual(await gateA.verify('s1'), undefined, '截断不得被误判成零测试');

  const staticCheck = runnerStub({ exitCode: 0, output: '', timedOut: false });
  const gateB = new TurnEndCompletionGate({
    policy: SelfVerifyPolicy.from({ command: 'npx tsc --noEmit' }),
    workspaceRoot: process.cwd(),
    runner: staticCheck.runner,
  });
  assert.strictEqual(await gateB.verify('s1'), undefined, '静态检查天然没有测试计数，必须放行');
});

/** 最小模型桩：本组用例只验装配，不跑回合。 */
const stubModel: ModelPort = {
  name: 'stub-model',
  generate: async () => ({ text: 'ok' }),
};

test('A1 收口：组合根真把闸门工厂注入运行时（缺这段＝闸门永不可达）', () => {
  const dir = workspaceWithTests();
  try {
    const runtime = Runtime.createRuntime(
      ConfigFactory.build({
        workspaceRoot: dir,
        maxSteps: 2,
        model: stubModel,
        storage: new MemoryStorage(),
        approvals: new AutoApproval(),
        sandbox: new PassthroughSandbox(),
        events: new SilentEventPort(),
      }),
    );
    const factory = runtime.completionGateFactory;
    assert.strictEqual(typeof factory, 'function', '组合根必须注入闸门工厂（A1 收口接线点）');
    const gate = factory?.({ tools: runtime.tools, selfVerify: undefined, workspaceRoot: dir });
    assert.strictEqual(gate?.kind, 'turn-end', '未启用写时自验证 ⇒ 回合末闸门');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
