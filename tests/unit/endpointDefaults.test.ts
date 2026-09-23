/**
 * 端点/地址**数据化**的回归（用户指令，2026-09-22 第三轮）。
 *
 * 被改的形态：`cliBuildConfig.buildModel` 与 `configBuilder.buildRouterAdapter` **各自硬编码**了
 * 同一组端点（`https://api.openai.com/v1` / `https://api.anthropic.com` / `http://localhost:11434`），
 * 插件市场索引、SWE-bench 的 GitHub 基址、浏览器 CDP 自检地址也各有字面量 ⇒ 企业换私有 registry /
 * GitHub Enterprise / 自建网关必须改代码重发。现统一收进 `defaults/endpoints.json`。
 *
 * 本测试钉住六件事：
 * ① 兜底值与历史字面量**逐项一致**（零配置行为不变是数据化的前提）；
 * ② env 覆盖优先级与「空白视为未设置」语义；
 * ③ 按标识取端点：未知 id **抛错**（拼错不静默）；
 * ④ 数据非法一律 fail-closed（缺字段 / 未知 key / 重复 id / 空数组）；
 * ⑤ **反硬编码守卫**：这些地址字面量不得再出现在 `src/**` 的代码行里（注释除外）；
 * ⑥ 消费点确实走数据（CDP 自检 URL 仍产出 `/json/version`）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EndpointDefaults, endpointDefaults } from '../../src/util/endpointDefaults.js';
import { BrowserAvailability } from '../../src/adapters/browser/browserAvailability.js';
import { DEFAULT_REGISTRY_URL } from '../../src/plugin/registrySourcesShared.js';

/** 仓库根（dist/tests/unit → 上溯三级）。 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** 历史字面量（改造前写在实现里），作为**不可漂移的期望值**保留。 */
const HISTORICAL_ADAPTERS: Readonly<
  Record<string, { baseUrl: string; model: string; requiresApiKey: boolean }>
> = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', requiresApiKey: true },
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-20250514',
    requiresApiKey: true,
  },
  responses: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', requiresApiKey: true },
  llamacpp: { baseUrl: 'http://localhost:11434', model: 'llama3', requiresApiKey: false },
};

/** 构造一份最小合法数据（用于反向用例，避免依赖真实文件）。 */
const validRaw = (): Record<string, unknown> => ({
  modelAdapters: [
    {
      id: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      requiresApiKey: true,
      apiKeyEnv: 'OPENAI_API_KEY',
      baseUrlEnv: 'OPENAI_BASE_URL',
      modelEnv: 'OPENAI_MODEL',
    },
  ],
  services: [{ id: 'gitRemoteBase', url: 'https://github.com/' }],
});

test('① 兜底值与历史字面量逐项一致（零配置行为不变）', () => {
  for (const [id, expected] of Object.entries(HISTORICAL_ADAPTERS)) {
    const record = endpointDefaults.adapterDefaults(id);
    assert.ok(record !== undefined, `数据文件应登记适配器 ${id}`);
    assert.strictEqual(record.baseUrl, expected.baseUrl, `${id}.baseUrl`);
    assert.strictEqual(record.model, expected.model, `${id}.model`);
    assert.strictEqual(record.requiresApiKey, expected.requiresApiKey, `${id}.requiresApiKey`);
  }
  // 凭据环境变量名逐条核对（llamacpp 免 Key，故不要求 apiKeyEnv）
  assert.strictEqual(endpointDefaults.adapterDefaults('openai')?.apiKeyEnv, 'OPENAI_API_KEY');
  assert.strictEqual(endpointDefaults.adapterDefaults('anthropic')?.apiKeyEnv, 'ANTHROPIC_API_KEY');
  assert.strictEqual(endpointDefaults.adapterDefaults('responses')?.apiKeyEnv, 'OPENAI_API_KEY');
  assert.strictEqual(endpointDefaults.adapterDefaults('llamacpp')?.apiKeyEnv, undefined);
  // 环境变量名（端点/模型）也必须与历史一致，否则老用户的 env 覆盖会静默失效
  assert.strictEqual(endpointDefaults.adapterDefaults('openai')?.baseUrlEnv, 'OPENAI_BASE_URL');
  assert.strictEqual(endpointDefaults.adapterDefaults('openai')?.modelEnv, 'OPENAI_MODEL');
  assert.strictEqual(
    endpointDefaults.adapterDefaults('anthropic')?.baseUrlEnv,
    'ANTHROPIC_BASE_URL',
  );
  assert.strictEqual(endpointDefaults.adapterDefaults('llamacpp')?.baseUrlEnv, 'OLLAMA_BASE_URL');
  assert.strictEqual(endpointDefaults.adapterDefaults('llamacpp')?.modelEnv, 'OLLAMA_MODEL');
});

test('② env 覆盖数据文件；空白视为未设置', () => {
  const resolved = endpointDefaults.resolveAdapter('openai', {
    OPENAI_API_KEY: 'sk-env',
    OPENAI_BASE_URL: 'https://gateway.internal/v1',
    OPENAI_MODEL: 'gpt-4o',
  });
  assert.strictEqual(resolved?.baseUrl, 'https://gateway.internal/v1');
  assert.strictEqual(resolved?.model, 'gpt-4o');
  assert.strictEqual(resolved?.apiKey, 'sk-env');
  // 未设置 ⇒ 回落数据文件；空白串同样视为未设置（与仓内既有 env 口径一致）
  const fallback = endpointDefaults.resolveAdapter('openai', { OPENAI_BASE_URL: '   ' });
  assert.strictEqual(fallback?.baseUrl, 'https://api.openai.com/v1');
  assert.strictEqual(fallback?.apiKey, undefined);
  // 未登记的适配器返回 undefined（适配器名本身由 CLI 枚举校验）
  assert.strictEqual(endpointDefaults.resolveAdapter('no-such-adapter', {}), undefined);
});

test('③ 服务端点：按标识取地址、env 可覆盖、未知标识抛错', () => {
  assert.strictEqual(endpointDefaults.urlOf('gitRemoteBase', {}), 'https://github.com/');
  assert.strictEqual(endpointDefaults.urlOf('githubApiBase', {}), 'https://api.github.com');
  assert.strictEqual(
    endpointDefaults.urlOf('githubApiBase', { GITHUB_API_URL: 'https://ghe.corp/api/v3' }),
    'https://ghe.corp/api/v3',
  );
  assert.strictEqual(
    endpointDefaults.urlOf('pluginRegistryIndex', {}),
    'https://registry.omniharness.dev/index.json',
  );
  assert.strictEqual(
    endpointDefaults.urlOf('pluginRegistryIndex', {
      OMNI_REGISTRY_URL: 'https://mirror.corp/idx.json',
    }),
    'https://mirror.corp/idx.json',
  );
  // 未知标识必须抛错：静默给 undefined 会让请求打到 `undefined/repos/...`
  assert.throws(() => endpointDefaults.urlOf('no-such-service', {}), /未登记服务端点/);
  // 占位符由调用方代入（本处只钉住模板本身）
  assert.strictEqual(
    endpointDefaults.urlOf('cdpProbeUrl', {}).replace('{port}', '9222'),
    'http://127.0.0.1:9222/json/version',
  );
});

test('④ 数据非法一律 fail-closed', () => {
  const bad =
    (mutate: (raw: Record<string, unknown>) => void): (() => EndpointDefaults) =>
    () => {
      const raw = validRaw();
      mutate(raw);
      return new EndpointDefaults(raw);
    };
  assert.throws(() => new EndpointDefaults(null), /应为对象/);
  assert.throws(() => new EndpointDefaults({ services: [] }), /modelAdapters 应为非空数组/);
  assert.throws(
    () => new EndpointDefaults({ modelAdapters: validRaw()['modelAdapters'], services: [] }),
    /services 应为非空数组/,
  );
  assert.throws(
    bad((raw) => ((raw['modelAdapters'] as unknown[])[0] = {})),
    /\.id/,
  );
  assert.throws(
    bad((raw) => {
      const first = (raw['modelAdapters'] as Record<string, unknown>[])[0] ?? {};
      first['baseUrl'] = 'ftp://nope';
    }),
    /baseUrl/,
  );
  assert.throws(
    bad((raw) => {
      const first = (raw['modelAdapters'] as Record<string, unknown>[])[0] ?? {};
      first['typo'] = 1;
    }),
    /未知 key/,
  );
  assert.throws(
    bad((raw) => {
      const list = raw['modelAdapters'] as unknown[];
      list.push({ ...(list[0] as Record<string, unknown>) });
    }),
    /重复使用标识/,
  );
  assert.throws(
    bad((raw) => {
      const first = (raw['modelAdapters'] as Record<string, unknown>[])[0] ?? {};
      first['requiresApiKey'] = 'yes';
    }),
    /requiresApiKey/,
  );
  // 非法数据不得静默降级：实例化即抛，早于任何请求
  assert.throws(
    bad((raw) => {
      (raw['services'] as unknown[])[0] = { id: 'x', url: '' };
    }),
    /url/,
  );
});

test('⑤ 反硬编码守卫：这些地址不得再出现在 src 的代码行里（注释除外）', () => {
  const literals = [
    'https://api.openai.com',
    'https://api.anthropic.com',
    'http://localhost:11434',
    'registry.omniharness.dev',
    'https://api.github.com',
    'https://github.com/',
    '/json/version',
  ];
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!name.endsWith('.ts') || name.endsWith('.d.ts')) continue;
      const rel = relative(repoRoot, full).split(sep).join('/');
      const lines = readFileSync(full, 'utf8').split(/\r?\n/);
      lines.forEach((line, index) => {
        const trimmed = line.trim();
        // 注释行（`* ...` / `// ...` / `/* ...`）是文档，允许提及地址；代码行不允许。
        if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
        for (const literal of literals) {
          if (line.includes(literal)) offenders.push(`${rel}:${index + 1} ${literal}`);
        }
      });
    }
  };
  walk(join(repoRoot, 'src'));
  assert.deepStrictEqual(
    offenders,
    [],
    `端点字面量必须只存在于 defaults/endpoints.json；以下代码行仍在硬编码：\n${offenders.join('\n')}`,
  );
});

test('⑥ 消费点走数据：CDP 自检 URL 与插件 registry 默认值', () => {
  // browserAvailability 的自检路径来自数据文件（常规值 /json/version，与历史一致）
  assert.strictEqual(
    BrowserAvailability.versionUrl('ws://127.0.0.1:9222/devtools/browser/abc'),
    'http://127.0.0.1:9222/json/version',
  );
  assert.strictEqual(
    BrowserAvailability.versionUrl('http://127.0.0.1:9222/'),
    'http://127.0.0.1:9222/json/version',
  );
  // 插件市场默认索引 = 数据文件值（env 覆盖在模块加载期生效）
  assert.strictEqual(DEFAULT_REGISTRY_URL, endpointDefaults.urlOf('pluginRegistryIndex'));
});
