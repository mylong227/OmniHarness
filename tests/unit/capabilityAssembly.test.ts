/**
 * Wave B5（ADR-0009 · EVOLVIX_SPEC §3 改造项）：`capability` 配置段与装配面判据。
 *
 * 判据口径：
 * - **拼错即报错**：未知子键 / 类型不符 / 档位枚举越界一律拒绝启动（落在安全档位上的静默忽略代价最高）；
 * - **缺省关 = 零行为变更**：`enabled !== true` ⇒ `capabilityStack` 为 undefined；
 * - **开启即三件齐**且**同一份技能表**：类型注册表（skill + workflow-template）、绞杀者注册表
 *   （在它上面 register 的技能，既有 `SkillRegistry` 立刻可见）、通用评估器；
 * - **档位下限只收紧**：配置写更严档 ⇒ 生效；配置想放宽 ⇒ 仍取更严者（放宽没有隐式路径）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConfigError } from '../../src/config/configError.js';
import { CapabilityStackAssembler } from '../../src/config/capabilityStackAssembler.js';
import { ConfigFactory } from '../../src/config/configFactory.js';
import { ArgParser } from '../../src/cli/argParser.js';
import { CliSubsystemSections } from '../../src/cli/cliSubsystemSections.js';
import { SkillRegistry } from '../../src/skill/skillRegistry.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';
import type { OmniHarnessConfig } from '../../src/config/configFactory.js';
import type { Skill } from '../../src/skill/skill.js';

/**
 * 造最小可用未解析配置。
 * @param extra 追加字段
 * @returns OmniHarnessConfig
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

test('B5 配置严格：未知子键 / 类型不符 / 枚举越界三类全部拒绝启动（拼错即报错）', () => {
  const cases: readonly { readonly capability: unknown; readonly match: RegExp }[] = [
    { capability: [], match: /capability 段必须是对象/ },
    { capability: true, match: /capability 段必须是对象/ },
    {
      capability: { enabled: true, isolationDefault: { isolation: 'wasm' } },
      match: /未知配置项 "isolationDefault"/,
    },
    { capability: { enabled: 'yes' }, match: /capability\.enabled 必须是布尔值/ },
    { capability: { sources: 'one-dir' }, match: /capability\.sources 必须是字符串数组/ },
    { capability: { sources: ['ok', 7] }, match: /capability\.sources 必须是字符串数组/ },
    {
      capability: { isolationDefaults: { trust: 'core' } },
      match: /isolationDefaults 段未知配置项 "trust"/,
    },
    {
      capability: { isolationDefaults: { trustTier: 'trusted' } },
      match: /trustTier 取值非法："trusted"/,
    },
    {
      capability: { isolationDefaults: { isolation: 'jail' } },
      match: /isolation 取值非法："jail"/,
    },
  ];
  for (const { capability, match } of cases) {
    assert.throws(
      // 走**配置文件校验入口**（`validateConfig` 是 `loadLayered` 的必经点）：本判据要钉的是
      // 「写进 omniharness.json 就会被拦」，而不是某个装配函数的入参检查。
      () => ConfigError.validateConfig({ capability } as never),
      (err: unknown) => {
        assert.ok(err instanceof ConfigError, `应抛 ConfigError，实际 ${String(err)}`);
        assert.match((err as Error).message, match);
        return true;
      },
      `配置 ${JSON.stringify(capability)} 必须被拒`,
    );
  }
  // 夹具自证：合法形态不得被这套断言误伤（否则上面的「全拒」可能只是校验器写坏了）。
  assert.doesNotThrow(() => ConfigError.validateConfig({ capability: { enabled: true } } as never));
});

test('B5 合法配置：三种合法形态都通过（含只写 enabled / 带 sources / 带更严档位）', () => {
  for (const capability of [
    { enabled: true },
    { enabled: true, sources: ['assets/packs'] },
    { enabled: true, isolationDefaults: { trustTier: 'external', isolation: 'os-sandbox' } },
    { enabled: false },
  ]) {
    const config = ConfigFactory.build(basePartial({ capability } as Partial<OmniHarnessConfig>));
    assert.ok(
      config.workspaceRoot.length > 0,
      `合法配置必须构造成功：${JSON.stringify(capability)}`,
    );
  }
});

test('B5 缺省关 = 零行为变更：enabled 缺省/为 false 时切片为 undefined', () => {
  assert.strictEqual(ConfigFactory.build(basePartial()).capabilityStack, undefined);
  assert.strictEqual(
    ConfigFactory.build(
      basePartial({ capability: { enabled: false } } as Partial<OmniHarnessConfig>),
    ).capabilityStack,
    undefined,
  );
  assert.strictEqual(
    CapabilityStackAssembler.assemble({ skillRegistry: new SkillRegistry() }),
    undefined,
    '装配器自己也守同一条：没配置就不装配',
  );
});

test('B5 开启即三件齐 + 同一份技能表（绞杀者第一态的实质）', () => {
  const skill: Skill = { name: 'seed-skill', description: 'd', instructions: 'i' };
  const config = ConfigFactory.build(
    basePartial({
      skills: [skill],
      capability: { enabled: true },
    } as Partial<OmniHarnessConfig>),
  );
  const stack = config.capabilityStack;
  assert.ok(stack !== undefined, 'enabled:true ⇒ 必须装配切片');
  assert.deepStrictEqual(stack.schemas.kinds(), ['skill', 'workflow-template'], '内置两类型已注册');
  assert.strictEqual(stack.registry.get('seed-skill'), config.skillRegistry.get('seed-skill'));

  // 通过协议注册表写入 ⇒ 既有技能表立刻可见（不是影子副本）。
  stack.registry.register({ name: 'added', description: 'd', instructions: 'i' });
  assert.ok(config.skillRegistry.get('added') !== undefined, '写入必须落在同一张表上');

  // 评估器接得上：技能资产按其 schema 的度量出走。
  assert.strictEqual(typeof stack.evaluator.evaluate, 'function');
});

test('B5 档位下限只收紧：配置更严 ⇒ 生效；配置想放宽 ⇒ 仍取出厂更严下限', () => {
  const build = (capability: unknown): { trustTier: string; isolation: string } | undefined =>
    CapabilityStackAssembler.assemble({
      skillRegistry: new SkillRegistry(),
      config: capability as never,
    })?.defaults;

  const fallback = build({ enabled: true });
  assert.deepStrictEqual(
    fallback,
    { trustTier: 'evolved', isolation: 'vm' },
    '出厂下限：签名/进化产物按 evolved + vm 起步',
  );
  assert.deepStrictEqual(
    build({ enabled: true, isolationDefaults: { trustTier: 'external', isolation: 'os-sandbox' } }),
    { trustTier: 'external', isolation: 'os-sandbox' },
    '配置更严 ⇒ 生效',
  );
  assert.deepStrictEqual(
    build({ enabled: true, isolationDefaults: { trustTier: 'core', isolation: 'in-process' } }),
    fallback,
    '配置想放宽 ⇒ 仍取下限（放宽没有隐式路径）',
  );
});

test('B5 CLI 通道：配置文件 capability 段经 configDefaults → CliSubsystemSections 到达 partial（不静默丢弃）', () => {
  const section = { enabled: true, isolationDefaults: { trustTier: 'external' as const } };
  const defaults = ArgParser.configDefaults({ capability: section });
  assert.deepStrictEqual(defaults.capability, section, '配置文件段必须映射进 CliArgs');

  const args = ArgParser.parseArgs(['--prompt', 'x'], defaults);
  assert.ok(args !== undefined);
  const partial = CliSubsystemSections.of(args);
  assert.deepStrictEqual(
    partial.capability,
    section,
    'CLI 段必须把配置带回 partial（四段接线闭环）',
  );

  // 未配置的段不得出现在 partial（否则组合根会以为「用户配了这个子系统」）。
  const bare = ArgParser.parseArgs(['--prompt', 'x']);
  assert.ok(bare !== undefined);
  assert.ok(!('capability' in CliSubsystemSections.of(bare)), '缺省不得注入空段');
});
