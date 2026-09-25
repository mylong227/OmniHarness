/**
 * 适配器工厂收口的回归（用户指定，审计 §3.4 的剩余两项）。
 *
 * 被改的形态（两处「改一处漏一处」）：
 * ① **模型适配器名 → 构造器** 的分支在 `cliBuildConfig.buildModel`（4 分支）、
 *    `configBuilder.buildRouterAdapter`（3 分支）、`providerProbe.buildModelForProvider`（2 分支）
 *    各写一遍；而「适配器名」还另有 3 处枚举/类型声明（`cliEnums` / `configError.ENUM_VALUES` /
 *    `FileConfig`），实测其中 `ENUM_VALUES` **漏了 `llamacpp`** ⇒ 配置文件写 `llamacpp` 被判非法。
 *    现构造只在 `adapters/model/modelAdapterRegistry.ts` 的表里。
 * ② **存储后端名 → 实现 + 缺省落盘路径** 的分支在 `cliBuildConfig.buildStorage` 内联
 *    （缺省 `process.cwd()` / `'omniharness.db'`），与 KV 后端的同形工厂各写一份。
 *    现收敛到 `cli/storageFactory.ts`。
 *
 * 本测试钉住五件事：① 三处适配器声明与表**机械一致**；② 表的兜底引用都真实存在；
 * ③ 探测/路由两条路径按表构造出正确类；④ 存储工厂的选择与缺省；⑤ **构造守卫**：
 * 模型适配器的 `new` 只允许出现在注册表里。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, rmSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MOCK_ADAPTER_ID,
  modelAdapterRegistry,
} from '../../src/adapters/model/modelAdapterRegistry.js';
import { MockModel } from '../../src/adapters/model/mockModel.js';
import { OpenAiCompatibleModel } from '../../src/adapters/model/openAiCompatibleModel.js';
import { AnthropicModel } from '../../src/adapters/model/anthropicModel.js';
import { ResponsesModel } from '../../src/adapters/model/responsesModel.js';
import { LlamaCppModel } from '../../src/adapters/model/llamaCppModel.js';
import { MODEL_ADAPTERS } from '../../src/cli/cliEnums.js';
import { storageFactory, DEFAULT_SQLITE_FILE } from '../../src/cli/storageFactory.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { JsonlStorage } from '../../src/adapters/storage/jsonlStorage.js';
import { SqliteStorage } from '../../src/adapters/storage/sqliteStorage.js';
import { ConfigError } from '../../src/config/configError.js';

import { ProviderProbe } from '../../src/server/services/providerProbe.js';
import { ConfigBuilder } from '../../src/config/configBuilder.js';
import { endpointDefaults } from '../../src/util/endpointDefaults.js';
import { providerPresets } from '../../src/config/providerPresets.js';

/** 仓库根（dist/tests/unit → 上溯三级）。 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('① 注册表 ↔ CLI 枚举 ↔ 配置校验白名单：三方一致（曾实测 llamacpp 漏在配置白名单）', () => {
  const registryIds = [...modelAdapterRegistry.ids()].sort();
  assert.deepStrictEqual(
    registryIds,
    [...MODEL_ADAPTERS].sort(),
    'cliEnums.MODEL_ADAPTERS 与模型适配器注册表必须逐项一致',
  );
  // 每个适配器名都必须能通过配置文件的枚举校验（这是 llamacpp 缺陷的机械防线）
  for (const id of registryIds) {
    assert.doesNotThrow(
      () => ConfigError.normalizeConfig({ modelAdapter: id }),
      `配置文件校验白名单缺 "${id}"（声明支持、校验拒绝）`,
    );
  }
  assert.ok(registryIds.includes(MOCK_ADAPTER_ID));
});

test('② 表的兜底引用真实存在：除 mock 外每个适配器都在 defaults/endpoints.json 有登记', () => {
  const withDefaults = modelAdapterRegistry
    .ids()
    .map((id) => modelAdapterRegistry.get(id))
    .filter((spec) => spec?.defaultsId !== undefined);
  assert.strictEqual(withDefaults.length, modelAdapterRegistry.ids().length - 1, '仅 mock 无兜底');
  for (const spec of withDefaults) {
    assert.ok(
      endpointDefaults.resolveAdapter(spec?.defaultsId ?? '', {}) !== undefined,
      `${spec?.id} 的兜底 id "${spec?.defaultsId}" 未登记于 defaults/endpoints.json`,
    );
  }
});

test('③ 厂商探测与模型路由都按表构造出正确类', () => {
  // 探测路径：preset.adapter → 具体类（用真实预设断言；免 Key 厂商不必给 Key）
  for (const preset of providerPresets.builtin) {
    const model = ProviderProbe.buildModelForProvider(
      preset,
      preset.needsKey ? 'sk-test' : undefined,
      undefined,
    );
    const expected =
      preset.adapter === 'anthropic'
        ? AnthropicModel
        : preset.adapter === 'responses'
          ? ResponsesModel
          : OpenAiCompatibleModel;
    assert.ok(model instanceof expected, `${preset.id} 应构造 ${expected.name}`);
  }
  // 必需 Key 缺失 ⇒ fail-closed（与表的 requiresApiKey 口径无关，这是厂商预设的 needsKey）
  const needKey = providerPresets.builtin.find((preset) => preset.needsKey);
  assert.ok(needKey !== undefined);
  assert.throws(
    () => ProviderProbe.buildModelForProvider(needKey, undefined, undefined),
    ConfigError,
  );

  // 路由路径：未知 adapter 抛 ConfigError（不静默退化）；mock 走表返回演示模型
  assert.throws(
    () => ConfigBuilder.buildRouterAdapter({ model: 'x', adapter: 'no-such-adapter' }),
    ConfigError,
  );
  assert.ok(
    ConfigBuilder.buildRouterAdapter({ model: 'x', adapter: MOCK_ADAPTER_ID }) instanceof MockModel,
  );
  assert.ok(
    ConfigBuilder.buildRouterAdapter({ model: 'x' }) instanceof MockModel,
    '缺省适配器应为 mock',
  );

  // 表内每一行都真的能造出对应的类（含 llamacpp——它免 Key，故不传 apiKey）
  const built = {
    openai: modelAdapterRegistry.get('openai')?.create({ baseUrl: 'https://x', model: 'm' }),
    anthropic: modelAdapterRegistry.get('anthropic')?.create({ baseUrl: 'https://x', model: 'm' }),
    responses: modelAdapterRegistry.get('responses')?.create({ baseUrl: 'https://x', model: 'm' }),
    llamacpp: modelAdapterRegistry
      .get('llamacpp')
      ?.create({ baseUrl: 'http://localhost:11434', model: 'llama3' }),
  };
  assert.ok(built.openai instanceof OpenAiCompatibleModel);
  assert.ok(built.anthropic instanceof AnthropicModel);
  assert.ok(built.responses instanceof ResponsesModel);
  assert.ok(built.llamacpp instanceof LlamaCppModel);
});

test('④ 存储工厂：后端选择与缺省落盘路径（单一实现来源）', async () => {
  // sqlite 后端会**真建数据库文件** ⇒ 一律落在临时目录，绝不写进仓库根
  // （本测试初版用相对路径，跑完在仓库根留下 `omniharness.db` / `custom.db`——属测试污染）。
  const dir = mkdtempSync(join(tmpdir(), 'omni-storage-factory-'));
  // sqlite 句柄会持有文件锁（Windows 上不 close 会导致清理 EBUSY）⇒ 收集后统一关闭
  const opened: { close(): void }[] = [];
  try {
    assert.ok((await storageFactory.createFor('memory', dir)) instanceof MemoryStorage);
    assert.ok((await storageFactory.createFor('jsonl', dir)) instanceof JsonlStorage);
    // sqlite 的第二参是**文件名**（不是目录）
    const sqliteDefault = await storageFactory.createFor('sqlite', join(dir, 'default.db'));
    const sqliteExplicit = await storageFactory.createFor('sqlite', join(dir, 'explicit.db'));
    assert.ok(sqliteDefault instanceof SqliteStorage);
    assert.ok(sqliteExplicit instanceof SqliteStorage);
    opened.push(sqliteDefault, sqliteExplicit);
    // 缺省文件名集中在工厂常量里（曾内联在 cliBuildConfig）
    assert.strictEqual(DEFAULT_SQLITE_FILE, 'omniharness.db');
    // 未识别的后端回落内存（无落盘副作用），与历史一致
    assert.ok((await storageFactory.createFor('no-such-backend', dir)) instanceof MemoryStorage);
  } finally {
    for (const handle of opened) handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⑤ 构造守卫：模型适配器的 new 只允许出现在注册表里', () => {
  const offenders: string[] = [];
  const pattern =
    /new (?:OpenAiCompatibleModel|AnthropicModel|ResponsesModel|LlamaCppModel|MockModel)\(/;
  const allow = new Set(['src/adapters/model/modelAdapterRegistry.ts']);
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!name.endsWith('.ts') || name.endsWith('.d.ts')) continue;
      const rel = relative(repoRoot, full).split(sep).join('/');
      if (allow.has(rel)) continue;
      readFileSync(full, 'utf8')
        .split(/\r?\n/)
        .forEach((line, index) => {
          const trimmed = line.trim();
          if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) {
            return;
          }
          if (pattern.test(line)) offenders.push(`${rel}:${index + 1}`);
        });
    }
  };
  walk(join(repoRoot, 'src'));
  assert.deepStrictEqual(
    offenders,
    [],
    `模型适配器构造必须只经注册表（新增适配器请在表里加一行）：\n${offenders.join('\n')}`,
  );
});

test('⑤-2 存储后端构造：会话存储的「后端名 → 实现」只在工厂里判断', () => {
  // 反硬编码守卫的轻量版：`storageAdapter === '<后端名>'` 的字符串分支只应出现在工厂。
  const offenders: string[] = [];
  const pattern = /storageAdapter\s*===\s*'/;
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!name.endsWith('.ts') || name.endsWith('.d.ts')) continue;
      const rel = relative(repoRoot, full).split(sep).join('/');
      if (rel === 'src/cli/storageFactory.ts') continue;
      readFileSync(full, 'utf8')
        .split(/\r?\n/)
        .forEach((line, index) => {
          const trimmed = line.trim();
          if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) {
            return;
          }
          if (pattern.test(line)) offenders.push(`${rel}:${index + 1}`);
        });
    }
  };
  walk(join(repoRoot, 'src'));
  assert.deepStrictEqual(
    offenders,
    [],
    `会话存储后端名分支必须只在 cli/storageFactory.ts：\n${offenders.join('\n')}`,
  );
});
