/**
 * `reasoning` 配置键的接线回归测试（针对第十处「声明未接线」）。
 *
 * 缺陷形态：`reasoning` 在 `FileConfig` / `ENUM_VALUES` / `ENV_ALIASES` 三处都被接受
 * （`docs/ARCHITECTURE_SPEC.md` 亦承诺它「直达模型请求」），**服务端**路径也已透传
 * （`appServerBase` 切工作区时 `file.reasoning ?? cfg.reasoning`），但 **CLI 路径**缺少
 * 「配置文件 → CliArgs → partial」两跳 ⇒ `omniharness.json` 的 `reasoning` 与
 * `OMNIHARNESS_REASONING` 在 CLI 上被静默丢弃。由接线完整性门禁的 I5a 不变量实测抓出。
 *
 * 本测试锁死：文件映射 → 装配透传 → 运行时读取，并锁定取值集合与校验器一致（7 档）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ConfigFactory } from '../../src/config/configFactory.js';
import { createRuntime } from '../../src/core/runtime.js';
import { configDefaults } from '../../src/cli/argParser.js';
import { normalizeConfig } from '../../src/config/configError.js';
import type { FileConfig } from '../../src/config/configFile.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';
import { MockModel } from '../../src/adapters/model/mockModel.js';
import { tempWorkspace } from '../helpers/tempWorkspace.js';

/** 校验器接受的 7 档推理强度（与 `ENUM_VALUES.reasoning` / 厂商预设清单同口径）。 */
const LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * 构造最小可用配置基线（必填四项 + 静默事件端口）。
 * @returns 可再展开覆盖的配置片段。
 */
const base = (): {
  workspaceRoot: string;
  maxSteps: number;
  model: MockModel;
  storage: MemoryStorage;
  events: SilentEventPort;
} => ({
  workspaceRoot: tempWorkspace(),
  maxSteps: 4,
  model: new MockModel(),
  storage: new MemoryStorage(),
  events: new SilentEventPort(),
});

test('reasoning：配置文件 → CliArgs 映射存在（修复前该字段在 CLI 侧完全缺失）', () => {
  const mapped = configDefaults({ reasoning: 'high' } as FileConfig);
  assert.strictEqual(mapped.reasoning, 'high');
});

test('reasoning：配置文件缺该键时不写入（保持 undefined，零行为变更）', () => {
  assert.strictEqual(configDefaults({} as FileConfig).reasoning, undefined);
});

test('reasoning：装配透传 → 运行时读得到（生产路径）', () => {
  const config = ConfigFactory.build({ ...base(), reasoning: 'xhigh' });
  assert.strictEqual(config.reasoning, 'xhigh');
  assert.strictEqual(createRuntime(config).config.reasoning, 'xhigh');
});

test('reasoning：7 档取值与校验器同口径（放宽类型不改校验白名单）', () => {
  for (const level of LEVELS) {
    assert.strictEqual(normalizeConfig({ reasoning: level }).reasoning, level);
  }
  assert.throws(() => normalizeConfig({ reasoning: 'bogus' }), '越界取值仍须 fail-closed');
});
