/**
 * 决策引擎「**装配即被消费**」判据（本仓最高频缺陷形态的机器化）。
 *
 * ## 为什么单独立一条判据
 *
 * 2026-10 实测的原始缺陷不是「引擎写错了」，而是**四段链路里三段静默断裂**：
 * 配置文件里没有 `decisionEngine` 这个 key（写进去被「未知配置项」拒绝）、CLI 没有任何旗标、
 * 组合根里 `mode` 从未非 off ⇒ 引擎恒不构造，项目内 1.7GB 的 venv + 权重零调用，
 * 而全程 fail-open 让这件事**连一行告警都没有**。当时全仓测试是绿的。
 *
 * 故这里把「配置 → 装配 → 消费」的**贯通性**钉成判据，而不是只测各段自身的形状：
 *   - 段活着穿到 `ResolvedConfig`（不是被展开时静默丢掉）；
 *   - `SelfVerifyingToolPort`（唯一消费点）确实拿到了引擎与模式（`verdictReady` / `verdictMode`）；
 *   - `off` / 缺省时零行为（不装配）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigFactory } from '../../src/config/configFactory.js';
import type { OmniHarnessConfig } from '../../src/config/configFactory.js';
import { SelfVerifyingToolPort } from '../../src/adapters/tool/verify/selfVerifyingToolPort.js';
import { CliDecisionEngineFlags } from '../../src/cli/cliDecisionEngineFlags.js';
import { CliDefaults } from '../../src/cli/argParser.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';

/**
 * 造最小可用未解析配置。
 * @param extra 追加字段。
 * @returns 未解析配置。
 */
function basePartial(extra: Partial<OmniHarnessConfig> = {}): OmniHarnessConfig {
  return {
    workspaceRoot: process.cwd(),
    maxSteps: 4,
    model: { generate: async () => ({ text: '' }) } as never,
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
    ...extra,
  };
}

/** 自验证开启（装饰器装配的前置条件；命令显式给出以免依赖仓库探测）。 */
const SELF_VERIFY: NonNullable<OmniHarnessConfig['selfVerify']> = {
  enabled: true,
  command: 'node -e ""',
};

test('装配即被消费：默认 CLI 决策引擎段贯通到自验证装饰器', () => {
  const section = CliDecisionEngineFlags.resolve({ ...CliDefaults, prompt: 'x' });
  assert.ok(section !== undefined, '生产入口默认应产出引擎段');

  const config = ConfigFactory.build(
    basePartial({ selfVerify: SELF_VERIFY, decisionEngine: section }),
  );
  assert.strictEqual(config.decisionEngine?.mode, 'shadow', '段必须活着穿到 ResolvedConfig');

  const port = config.tools;
  assert.ok(port instanceof SelfVerifyingToolPort, '自验证开启时应装配装饰器');
  assert.strictEqual(port.verdictMode, 'shadow', '模式必须抵达消费点（否则只是声明）');
  assert.strictEqual(
    port.verdictReady,
    true,
    '决策引擎实例必须真的抵达自验证回环（修补前：CLI 无入口 ⇒ 恒不装配）',
  );
});

test('零行为：未给决策引擎段时装饰器不接引擎', () => {
  const config = ConfigFactory.build(basePartial({ selfVerify: SELF_VERIFY }));
  assert.strictEqual(config.decisionEngine, undefined);
  const port = config.tools;
  assert.ok(port instanceof SelfVerifyingToolPort);
  assert.strictEqual(port.verdictMode, undefined);
  assert.strictEqual(port.verdictReady, false);
});

test('零行为：mode=off 时不装配引擎（与缺省一致）', () => {
  const config = ConfigFactory.build(
    basePartial({ selfVerify: SELF_VERIFY, decisionEngine: { mode: 'off' } }),
  );
  const port = config.tools;
  assert.ok(port instanceof SelfVerifyingToolPort);
  assert.strictEqual(port.verdictMode, undefined);
  assert.strictEqual(port.verdictReady, false);
});

test('enforce 档同样贯通（模式不被归一化时丢掉）', () => {
  const config = ConfigFactory.build(
    basePartial({ selfVerify: SELF_VERIFY, decisionEngine: { mode: 'enforce' } }),
  );
  const port = config.tools;
  assert.ok(port instanceof SelfVerifyingToolPort);
  assert.strictEqual(port.verdictMode, 'enforce');
  assert.strictEqual(port.verdictReady, true);
});
