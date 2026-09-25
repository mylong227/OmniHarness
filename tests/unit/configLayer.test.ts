import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { ConfigError } from '../../src/config/configError.js';
import { configFile, type FileConfig } from '../../src/config/configFile.js';
import { profileLoader } from '../../src/config/profileLoader.js';

describe('configLayer: 别名归一化', () => {
  it('下划线/连字符别名归一为标准 key', () => {
    const cfg = ConfigError.normalizeConfig({
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
    assert.throws(() => ConfigError.normalizeConfig({ mysteriousKey: 1 }), ConfigError);
    assert.throws(() => ConfigError.normalizeConfig({ model_adapterx: 'openai' }), ConfigError);
  });
});

describe('configLayer: 严格校验', () => {
  it('枚举越界抛 ConfigError', () => {
    assert.throws(() => ConfigError.validateConfig({ approval: 'whatever' as never }), ConfigError);
    assert.throws(() => ConfigError.validateConfig({ sandbox: 'magic' as never }), ConfigError);
  });

  it('类型错误抛 ConfigError', () => {
    assert.throws(() => ConfigError.validateConfig({ maxSteps: -3 } as FileConfig), ConfigError);
    assert.throws(() => ConfigError.validateConfig({ model: 123 } as never), ConfigError);
    assert.throws(() => ConfigError.validateConfig({ mcpServers: 'nope' } as never), ConfigError);
  });

  it('合法枚举/数字通过', () => {
    assert.doesNotThrow(() =>
      ConfigError.validateConfig({ approval: 'deny', maxSteps: 10, sandbox: 'policy' }),
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
    const env = ConfigError.readEnvConfig();
    assert.strictEqual(env.model, 'gpt-4');
    assert.strictEqual(env.approval, 'deny');
    assert.strictEqual(env.maxSteps, 7);
  });

  it('无关环境变量被忽略', () => {
    process.env.PATH = '/usr/bin';
    process.env.OMNIHARNESS_UNKNOWN = 'x';
    const env = ConfigError.readEnvConfig();
    assert.deepStrictEqual(env, {});
  });

  it('环境变量枚举越界仍抛 ConfigError', () => {
    process.env.OMNIHARNESS_SANDBOX = 'bogus';
    assert.throws(() => ConfigError.readEnvConfig(), ConfigError);
  });
});

describe('configLayer: 多层合并', () => {
  it('靠后层非零值覆盖靠前层，undefined 不覆盖', () => {
    const base: FileConfig = { model: 'a', approval: 'auto' };
    const override: FileConfig = { model: 'b', maxSteps: 3 };
    const merged = ConfigError.mergeConfigs(base, override);
    assert.strictEqual(merged.model, 'b');
    assert.strictEqual(merged.approval, 'auto');
    assert.strictEqual(merged.maxSteps, 3);
  });

  it('mcpServers 数组整体替换不拼接', () => {
    const a: FileConfig = { mcpServers: [{ name: 'x', command: 'c1' }] };
    const b: FileConfig = { mcpServers: [{ name: 'y', command: 'c2' }] };
    const merged = ConfigError.mergeConfigs(a, b);
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
  let home: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oh-layered-'));
    // 用户层隔离：真实机器可能存在 ~/.omniharness/omniharness.json，会渗进断言（非封闭测试）
    home = mkdtempSync(join(tmpdir(), 'oh-layered-home-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
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
    const merged = configFile.loadLayered({ workspace: dir, profile: 'strict', userHomedir: home });
    assert.strictEqual(merged.model, 'base');
    assert.strictEqual(merged.approval, 'deny'); // profile 覆盖
    assert.strictEqual(merged.sandbox, 'policy');
    assert.strictEqual(merged.maxSteps, 4);
  });

  it('项目文件含未知 key 严格抛错', () => {
    writeFileSync(join(dir, 'omniharness.json'), JSON.stringify({ weird_field: true }));
    assert.throws(() => configFile.loadLayered({ workspace: dir, userHomedir: home }), ConfigError);
  });

  it('未指定 profile 时不加载 profile 层', () => {
    writeFileSync(join(dir, 'omniharness.json'), JSON.stringify({ model: 'ok' }));
    const merged = configFile.loadLayered({ workspace: dir, userHomedir: home });
    assert.strictEqual(merged.model, 'ok');
    assert.strictEqual(merged.approval, undefined);
  });

  it('不存在的 profile 抛 ConfigError', () => {
    writeFileSync(join(dir, 'omniharness.json'), JSON.stringify({ model: 'ok' }));
    assert.throws(
      () => configFile.loadLayered({ workspace: dir, userHomedir: home, profile: 'ghost' }),
      ConfigError,
    );
  });
});

describe('profile: extends 继承（A2）', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oh-profile-ext-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('子 profile 覆盖父、未声明字段继承父值', () => {
    const profiles = join(dir, 'profiles');
    mkdirSync(profiles, { recursive: true });
    writeFileSync(
      join(profiles, 'base.json'),
      JSON.stringify({ approval: 'deny', sandbox: 'policy', model: 'base-model' }),
    );
    writeFileSync(
      join(profiles, 'dev.json'),
      JSON.stringify({ extends: 'base', approval: 'auto' }),
    );
    const loaded = profileLoader.load(join(profiles, 'dev.json'));
    assert.strictEqual(loaded.approval, 'auto'); // 子覆盖父
    assert.strictEqual(loaded.sandbox, 'policy'); // 继承父
    assert.strictEqual(loaded.model, 'base-model');
  });

  it('多级继承（top → mid → base），逐级覆盖与继承', () => {
    const profiles = join(dir, 'profiles');
    mkdirSync(profiles, { recursive: true });
    writeFileSync(join(profiles, 'base.json'), JSON.stringify({ sandbox: 'policy', model: 'm' }));
    writeFileSync(
      join(profiles, 'mid.json'),
      JSON.stringify({ extends: 'base', approval: 'auto' }),
    );
    writeFileSync(join(profiles, 'top.json'), JSON.stringify({ extends: 'mid', max_steps: 9 }));
    const loaded = profileLoader.load(join(profiles, 'top.json'));
    assert.strictEqual(loaded.sandbox, 'policy');
    assert.strictEqual(loaded.approval, 'auto');
    assert.strictEqual(loaded.maxSteps, 9);
  });

  it('父 profile 不存在时 fail-closed 抛错', () => {
    const profiles = join(dir, 'profiles');
    mkdirSync(profiles, { recursive: true });
    writeFileSync(join(profiles, 'orphan.json'), JSON.stringify({ extends: 'ghost' }));
    assert.throws(() => profileLoader.load(join(profiles, 'orphan.json')), ConfigError);
  });

  it('继承存在环时 fail-closed 抛错', () => {
    const profiles = join(dir, 'profiles');
    mkdirSync(profiles, { recursive: true });
    writeFileSync(join(profiles, 'a.json'), JSON.stringify({ extends: 'b' }));
    writeFileSync(join(profiles, 'b.json'), JSON.stringify({ extends: 'a' }));
    assert.throws(() => profileLoader.load(join(profiles, 'a.json')), ConfigError);
  });
});

describe('configFile.loadLayered: permission 段透传（A2）', () => {
  let dir: string;
  let home: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oh-perm-'));
    home = mkdtempSync(join(tmpdir(), 'oh-perm-home-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('项目文件的 permission.rules 保留在合并结果中', () => {
    writeFileSync(
      join(dir, 'omniharness.json'),
      JSON.stringify({
        permission: { rules: [{ toolName: 'shell', commandGlob: '*rm -rf*', decision: 'deny' }] },
      }),
    );
    const merged = configFile.loadLayered({ workspace: dir, userHomedir: home });
    assert.strictEqual(merged.permission?.rules?.length, 1);
    assert.strictEqual(merged.permission?.rules?.[0]?.commandGlob, '*rm -rf*');
  });

  it('permission 含非法规则时 loadLayered 抛 ConfigError', () => {
    writeFileSync(
      join(dir, 'omniharness.json'),
      JSON.stringify({ permission: { rules: [{ decision: 'maybe' }] } }),
    );
    assert.throws(() => configFile.loadLayered({ workspace: dir, userHomedir: home }), ConfigError);
  });
});
