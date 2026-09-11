import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  ConfigError,
  mergeConfigs,
  normalizeConfig,
  readEnvConfig,
  validateConfig,
} from '../../src/config/configLayer.js';
import { configFile, type FileConfig } from '../../src/config/configFile.js';
import { profileLoader } from '../../src/config/profile.js';

describe('configLayer: 别名归一化', () => {
  it('下划线/连字符别名归一为标准 key', () => {
    const cfg = normalizeConfig({
      model_adapter: 'openai',
      base_url: 'https://x',
      api_key: 'k',
      storage_adapter: 'jsonl',
      max_steps: 5,
      'elevated-sandbox': 'policy',
    });
    assert.strictEqual(cfg.modelAdapter, 'openai');
    assert.strictEqual(cfg.baseUrl, 'https://x');
    assert.strictEqual(cfg.apiKey, 'k');
    assert.strictEqual(cfg.storageAdapter, 'jsonl');
    assert.strictEqual(cfg.maxSteps, 5);
    assert.strictEqual(cfg.elevatedSandbox, 'policy');
  });

  it('未知 key 抛 ConfigError（fail-closed）', () => {
    assert.throws(() => normalizeConfig({ mysteriousKey: 1 }), ConfigError);
    assert.throws(() => normalizeConfig({ model_adapterx: 'openai' }), ConfigError);
  });
});

describe('configLayer: 严格校验', () => {
  it('枚举越界抛 ConfigError', () => {
    assert.throws(() => validateConfig({ approval: 'whatever' as never }), ConfigError);
    assert.throws(() => validateConfig({ sandbox: 'magic' as never }), ConfigError);
  });

  it('类型错误抛 ConfigError', () => {
    assert.throws(() => validateConfig({ maxSteps: -3 } as FileConfig), ConfigError);
    assert.throws(() => validateConfig({ model: 123 } as never), ConfigError);
    assert.throws(() => validateConfig({ mcpServers: 'nope' } as never), ConfigError);
  });

  it('合法枚举/数字通过', () => {
    assert.doesNotThrow(() =>
      validateConfig({ approval: 'deny', maxSteps: 10, sandbox: 'policy' }),
    );
  });
});

describe('configLayer: 环境变量层', () => {
  const saved = process.env;
  beforeEach(() => {
    process.env = { ...saved };
  });
  afterEach(() => {
    process.env = saved;
  });

  it('OMNIHARNESS_* 映射到标准 key 并 coerce 数字', () => {
    process.env.OMNIHARNESS_MODEL = 'gpt-4';
    process.env.OMNIHARNESS_APPROVAL = 'deny';
    process.env.OMNIHARNESS_MAX_STEPS = '7';
    const env = readEnvConfig();
    assert.strictEqual(env.model, 'gpt-4');
    assert.strictEqual(env.approval, 'deny');
    assert.strictEqual(env.maxSteps, 7);
  });

  it('无关环境变量被忽略', () => {
    process.env.PATH = '/usr/bin';
    process.env.OMNIHARNESS_UNKNOWN = 'x';
    const env = readEnvConfig();
    assert.deepStrictEqual(env, {});
  });

  it('环境变量枚举越界仍抛 ConfigError', () => {
    process.env.OMNIHARNESS_SANDBOX = 'bogus';
    assert.throws(() => readEnvConfig(), ConfigError);
  });
});

describe('configLayer: 多层合并', () => {
  it('靠后层非零值覆盖靠前层，undefined 不覆盖', () => {
    const base: FileConfig = { model: 'a', approval: 'auto' };
    const override: FileConfig = { model: 'b', maxSteps: 3 };
    const merged = mergeConfigs(base, override);
    assert.strictEqual(merged.model, 'b');
    assert.strictEqual(merged.approval, 'auto');
    assert.strictEqual(merged.maxSteps, 3);
  });

  it('mcpServers 数组整体替换不拼接', () => {
    const a: FileConfig = { mcpServers: [{ name: 'x', command: 'c1' }] };
    const b: FileConfig = { mcpServers: [{ name: 'y', command: 'c2' }] };
    const merged = mergeConfigs(a, b);
    assert.strictEqual(merged.mcpServers?.length, 1);
    assert.strictEqual(merged.mcpServers?.[0]?.name, 'y');
  });
});

describe('profile: 查找与加载', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oh-profile-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('项目级 ./profiles/<name>.json 被找到', () => {
    const profiles = join(dir, 'profiles');
    mkdirSync(profiles, { recursive: true });
    writeFileSync(join(profiles, 'dev.json'), JSON.stringify({ approval: 'deny' }));
    const found = profileLoader.find(dir, 'dev');
    assert.ok(found !== undefined);
    assert.strictEqual(profileLoader.load(found).approval, 'deny');
  });

  it('profile 含未知 key 时严格抛错', () => {
    const profiles = join(dir, 'profiles');
    mkdirSync(profiles, { recursive: true });
    writeFileSync(join(profiles, 'bad.json'), JSON.stringify({ nope: 1 }));
    const found = profileLoader.find(dir, 'bad');
    assert.ok(found !== undefined);
    assert.throws(() => profileLoader.load(found), ConfigError);
  });

  it('未找到 profile 返回 undefined', () => {
    assert.strictEqual(profileLoader.find(dir, 'missing'), undefined);
  });
});

describe('configFile.loadLayered: 分层合并 + 严格校验', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oh-layered-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('项目文件 + profile 合并，profile 覆盖', () => {
    writeFileSync(
      join(dir, 'omniharness.json'),
      JSON.stringify({ model: 'base', approval: 'auto', max_steps: 4 }),
    );
    const profiles = join(dir, 'profiles');
    mkdirSync(profiles, { recursive: true });
    writeFileSync(
      join(profiles, 'strict.json'),
      JSON.stringify({ approval: 'deny', sandbox: 'policy' }),
    );
    const merged = configFile.loadLayered({ workspace: dir, profile: 'strict' });
    assert.strictEqual(merged.model, 'base');
    assert.strictEqual(merged.approval, 'deny'); // profile 覆盖
    assert.strictEqual(merged.sandbox, 'policy');
    assert.strictEqual(merged.maxSteps, 4);
  });

  it('项目文件含未知 key 严格抛错', () => {
    writeFileSync(join(dir, 'omniharness.json'), JSON.stringify({ weird_field: true }));
    assert.throws(() => configFile.loadLayered({ workspace: dir }), ConfigError);
  });

  it('未指定 profile 时不加载 profile 层', () => {
    writeFileSync(join(dir, 'omniharness.json'), JSON.stringify({ model: 'ok' }));
    const merged = configFile.loadLayered({ workspace: dir });
    assert.strictEqual(merged.model, 'ok');
    assert.strictEqual(merged.approval, undefined);
  });

  it('不存在的 profile 抛 ConfigError', () => {
    writeFileSync(join(dir, 'omniharness.json'), JSON.stringify({ model: 'ok' }));
    assert.throws(() => configFile.loadLayered({ workspace: dir, profile: 'ghost' }), ConfigError);
  });
});
