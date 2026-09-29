/**
 * self-verify 接 Laya verdict 预判（shadow 观测档）单测。
 *
 * 锁死权威缝：注入 `verdictPredictor`（决策引擎）后，`SelfVerifyingToolPort.execute`
 * 在「写源码成功」路径上**确实消费**它——跑测试前做一次 noul 预判，并把观测记录交给
 * `verdictObserver`。验证「库里有了 Laya 能力 ≠ 路径上生效」：配置/端口声明必须透传到
 * execute 的真实调用链。
 *
 * 关键不变量：verdict 观测**不**进回灌 notes、不阻断主流程（fail-open 质量信号）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SelfVerifyingToolPort,
  type VerdictObservation,
} from '../../src/adapters/tool/verify/selfVerifyingToolPort.js';
import { SelfVerifyPolicy } from '../../src/adapters/tool/verify/selfVerifyPolicy.js';
import type {
  DecisionEngine,
  DecisionRequest,
  DecisionResponse,
} from '../../src/ports/decision/decisionEngine.js';
import type { ToolPort, ToolCall, ToolContext, ToolResult } from '../../src/ports/tool/tool.js';
import type { TestCommandRunner } from '../../src/adapters/tool/verify/testCommandRunner.js';

/** 替身决策引擎：noul=0.9。 */
class StubDecisionEngine implements DecisionEngine {
  /** 端口名。 */
  public readonly name = 'stub';

  /** @returns 始终可用。 */
  public isAvailable(): boolean {
    return true;
  }

  /**
   * @param _request 决策请求（忽略）。
   * @returns 固定 noul=0.9。
   */
  public async decide(_request: DecisionRequest): Promise<DecisionResponse> {
    return { answers: { passTest: { noul: 0.9 } }, available: true };
  }
}

/** 透传内层端口（execute 返回 ok）。 */
const inner: ToolPort = {
  name: 'stub-inner',
  list: () => [],
  listDirect: () => [],
  unregister: () => false,
  execute: async (): Promise<ToolResult> => ({ callId: 'c1', ok: true, output: 'ok' }),
};

/** 恒通过的测试执行器替身。 */
const passingRunner: TestCommandRunner = {
  run: async () => ({ exitCode: 0, timedOut: false, output: '' }),
};

/** 构造一个「写源码」的调用（path 命中源码扩展名）。 */
const writeCall: ToolCall = {
  callId: 'c1',
  name: 'edit_file',
  arguments: { path: 'a.ts', content: 'x' },
} as unknown as ToolCall;

test('注入 verdictPredictor 后写源码触发 shadow 观测', async () => {
  const observations: VerdictObservation[] = [];
  const policy = SelfVerifyPolicy.from({ command: 'echo noop' });
  const port = new SelfVerifyingToolPort(inner, {
    policy,
    workspaceRoot: process.cwd(),
    runner: passingRunner,
    shouldVerify: () => true,
    verdictPredictor: new StubDecisionEngine(),
    verdictObserver: (o) => observations.push(o),
  });
  const ctx = { sessionId: 's1' } as unknown as ToolContext;
  const result = await port.execute(writeCall, ctx);
  assert.strictEqual(observations.length, 1);
  const obs = observations[0];
  assert.ok(obs);
  assert.strictEqual(obs.noul, 0.9);
  assert.strictEqual(obs.toolName, 'edit_file');
  assert.strictEqual(obs.available, true);
  // 观测不进回灌、不阻断：原结果透传。
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.output, 'ok');
});

test('未注入 verdictPredictor 时不观测（零行为回归）', async () => {
  const observations: VerdictObservation[] = [];
  const policy = SelfVerifyPolicy.from({ command: 'echo noop' });
  const port = new SelfVerifyingToolPort(inner, {
    policy,
    workspaceRoot: process.cwd(),
    runner: passingRunner,
    shouldVerify: () => true,
    verdictObserver: (o) => observations.push(o),
  });
  const ctx = { sessionId: 's2' } as unknown as ToolContext;
  await port.execute(writeCall, ctx);
  assert.strictEqual(observations.length, 0);
});
