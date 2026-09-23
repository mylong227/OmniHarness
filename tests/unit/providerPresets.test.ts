/**
 * 厂商目录**数据化**的回归（用户指令，2026-09-22 第二轮）。
 *
 * 被改的形态：厂商目录硬编码在 `server/services/providerPresets.ts`，而 CLI 另有一份手工副本
 * `ADAPTER_PRESETS`（注释自称「与 providerPresets.ts 同源同步」）——加一家厂商要改两处，
 * 两处漂移会出现「UI 有这家厂商、CLI 解析不到」的隐性缺口。现：
 * 数据在 `defaults/providers.json`，合并/派生逻辑只有 `config/providerPresets.ts` 一份。
 *
 * 本测试钉住五件事：
 * ① 内建目录**逐字来自数据文件**（代码里没有第二份表）；
 * ② CLI 适配器映射与原 `ADAPTER_PRESETS` **逐项等价**（含 ollama 不在 openai 名下这类细节）；
 * ③ 用户覆盖是「同 id 整条替换 + 新 id 追加」，不做字段级隐式继承；
 * ④ 非法覆盖一律抛错（fail-closed），不静默丢弃；
 * ⑤ 配置段校验器与运行时求解器**同源**（同一批拒绝项）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROVIDER_PRESETS,
  providerPresets,
  type ProviderPreset,
} from '../../src/config/providerPresets.js';
import { providerPresetValidator } from '../../src/config/providerPresetValidator.js';
import { adapterPresets, configDefaults } from '../../src/cli/argParser.js';
import { normalizeConfig, ConfigError } from '../../src/config/configError.js';
import type { FileConfig } from '../../src/config/configFile.js';

/** 仓库根（dist/tests/unit → 上溯三级）。 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * 把任意值断言成厂商预设（供**故意构造非法输入**的用例绕过类型检查）。
 * @param value 任意值
 * @returns 同一个值，类型标注为 ProviderPreset
 */
const asPreset = (value: unknown): ProviderPreset => value as ProviderPreset;

/** 某个内建厂商的完整记录（用于「只改一个字段」的覆盖用例）。 */
const builtinOf = (id: string): ProviderPreset => {
  const preset = providerPresets.byId(id);
  assert.ok(preset !== undefined, `内建目录应含厂商 ${id}`);
  return preset;
};

/**
 * 原 CLI 手工副本 `ADAPTER_PRESETS` 的等价契约（已删除，此处作为**不可漂移的期望值**保留）。
 * 注意 ollama：其 `adapter` 是 openai（兼容层），但 CLI 侧归属 llamacpp，且**不在** openai 名下。
 */
const EXPECTED_CLI_ADAPTERS: Readonly<Record<string, readonly string[]>> = {
  openai: ['deepseek', 'moonshot', 'zhipu', 'dashscope', 'openai'],
  anthropic: ['anthropic'],
  responses: ['openai'],
  llamacpp: ['ollama'],
};

test('① 内建目录逐字来自 defaults/providers.json', () => {
  const file = join(repoRoot, 'defaults', 'providers.json');
  assert.ok(existsSync(file), `厂商目录数据文件必须随包发布：${file}`);
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { presets: ProviderPreset[] };
  assert.deepStrictEqual(
    raw.presets,
    PROVIDER_PRESETS.map((preset) => ({ ...preset })),
  );
  // 抽查关键字段：端点与免 Key 标记不得在搬迁中漂移
  assert.strictEqual(providerPresets.byId('deepseek')?.baseUrl, 'https://api.deepseek.com');
  assert.strictEqual(providerPresets.byId('ollama')?.needsKey, false);
  assert.strictEqual(providerPresets.byId('no-such-vendor'), undefined);
});

test('② CLI 适配器映射与原手工副本逐项等价（含 ollama 的归属）', () => {
  for (const [adapter, ids] of Object.entries(EXPECTED_CLI_ADAPTERS)) {
    assert.deepStrictEqual(
      adapterPresets(adapter).map((preset) => preset.id),
      ids,
      `--model-adapter ${adapter} 的厂商顺序/归属必须与改造前一致`,
    );
  }
  assert.deepStrictEqual(adapterPresets('no-such-adapter'), []);
});

test('③ 覆盖语义：同 id 整条替换（保持原位置）、新 id 追加到末尾', () => {
  const acme: ProviderPreset = {
    id: 'acme',
    label: 'ACME 自建网关',
    adapter: 'openai',
    baseUrl: 'https://acme.example/v1',
    defaultModel: 'acme-1',
    needsKey: true,
    models: ['acme-1', 'acme-2'],
  };
  const effective = providerPresets.resolve([
    { ...builtinOf('openai'), baseUrl: 'https://gateway.internal/v1' },
    acme,
  ]);
  assert.strictEqual(effective.length, PROVIDER_PRESETS.length + 1);
  // 替换：baseUrl 生效，且仍在原下标（顺序不影响 UI 卡片与 providerKeys 兜底的优先级）
  assert.strictEqual(effective[4]?.id, 'openai');
  assert.strictEqual(
    providerPresets.byId('openai', [
      { ...builtinOf('openai'), baseUrl: 'https://gateway.internal/v1' },
    ])?.baseUrl,
    'https://gateway.internal/v1',
  );
  // 追加：新厂商可被 CLI 适配器映射到（自建厂商也能吃 providerKeys 兜底）
  assert.strictEqual(effective[effective.length - 1]?.id, 'acme');
  assert.deepStrictEqual(
    providerPresets.forAdapter('openai', effective).map((preset) => preset.id),
    [...(EXPECTED_CLI_ADAPTERS['openai'] ?? []), 'acme'],
  );
  // 未声明覆盖时返回内建目录本身（零成本、零漂移）
  assert.strictEqual(providerPresets.resolve(), PROVIDER_PRESETS);
});

test('④ 非法覆盖 fail-closed（缺字段 / 类型错 / 越界 / 未知 key / 重复 id）', () => {
  const openai = builtinOf('openai');
  assert.throws(() => providerPresets.resolve([asPreset({})]), /\.id/);
  assert.throws(
    () => providerPresets.resolve([asPreset({ ...openai, adapter: 'nope' })]),
    /adapter/,
  );
  assert.throws(
    () => providerPresets.resolve([asPreset({ ...openai, needsKey: 'yes' })]),
    /needsKey/,
  );
  assert.throws(() => providerPresets.resolve([asPreset({ ...openai, models: [1] })]), /models/);
  assert.throws(
    () => providerPresets.resolve([asPreset({ ...openai, baseUrl: 'ftp://x' })]),
    /baseUrl/,
  );
  assert.throws(() => providerPresets.resolve([asPreset({ ...openai, baseUrl: '' })]), /baseUrl/);
  assert.throws(() => providerPresets.resolve([asPreset({ ...openai, nope: 1 })]), /未知 key/);
  assert.throws(() => providerPresets.resolve([openai, openai]), /重复厂商 id/);
});

test('④-2 CLI 兜底用上覆盖后的目录（自建厂商也能吃到 providerKeys）', () => {
  const file: FileConfig = {
    modelAdapter: 'openai',
    providerKeys: { acme: 'sk-acme' },
    providerPresets: [
      {
        id: 'acme',
        label: 'ACME 自建网关',
        adapter: 'openai',
        baseUrl: 'https://acme.example/v1',
        defaultModel: 'acme-1',
        needsKey: true,
        models: ['acme-1'],
      },
    ],
  };
  const defaults = configDefaults(file);
  assert.strictEqual(defaults.apiKey, 'sk-acme');
  assert.strictEqual(defaults.baseUrl, 'https://acme.example/v1');
});

test('⑤ 配置段校验器与运行时求解器同源（同一批拒绝项）', () => {
  const openai = builtinOf('openai');
  const asConfig = (providerPresetsRaw: unknown): FileConfig =>
    ({ providerPresets: providerPresetsRaw }) as unknown as FileConfig;
  assert.strictEqual(providerPresetValidator.validate(asConfig(undefined)), undefined);
  assert.strictEqual(providerPresetValidator.validate(asConfig([openai])), undefined);
  assert.match(String(providerPresetValidator.validate(asConfig({}))), /应为数组/);
  // 与 providerPresets.resolve 同一批拒绝项（同源，不出现双口径）
  assert.match(
    String(providerPresetValidator.validate(asConfig([{ ...openai, adapter: 'nope' }]))),
    /adapter/,
  );
  assert.match(
    String(providerPresetValidator.validate(asConfig([{ ...openai, baseUrl: 'nope' }]))),
    /baseUrl/,
  );
});

test('⑥ normalizeConfig：providerPresets 合法即通过、非法即 ConfigError（严格配置链）', () => {
  const openai = builtinOf('openai');
  const ok = normalizeConfig({ providerPresets: [openai] } as Record<string, unknown>);
  assert.deepStrictEqual(ok.providerPresets, [openai]);
  assert.throws(
    () => normalizeConfig({ providerPresets: 'not-an-array' } as Record<string, unknown>),
    ConfigError,
  );
  assert.throws(
    () =>
      normalizeConfig({
        providerPresets: [{ ...openai, adapter: 'nope' }],
      } as Record<string, unknown>),
    ConfigError,
  );
});
