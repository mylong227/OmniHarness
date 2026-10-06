/**
 * serve 的 RPC 配置面必须与**进程启动口径**一致：用户级配置不能在这里被静默忽略
 * （2026-10-06 第六十二轮真机 UI 跑测实测）。
 *
 * ## 它锁的是什么（现场形态）
 *
 * 用户在**用户级** `~/.omniharness/omniharness.json` 里放 `providerKeys.deepseek`，在**项目级**
 * `omniharness.json` 里只写 `model`——这是最常见的一种合法配置。真机跑测时：
 *
 * - `dsh exec`（`execCli.loadDefaults`）与 `serve` **启动路径**（`loadServeConfig`）都走 `loadLayered`，
 *   一切正常；
 * - 但 `ServerConfigStore.fileConfig()` 只读**项目级那一份**，于是 RPC 面看不到 `providerKeys`：
 *   `model.probe` 报「无凭据」、`ModelCatalogService.resolveOverride()` 直接抛
 *   `厂商 DeepSeek 未配置 API Key，无法启用（fail-closed）` ⇒ **Web UI 一发真模型回合就在流里报错**。
 *
 * | # | 判据 |
 * | --- | --- |
 * | ① | 用户级 `providerKeys` 必须在 `fileConfig()` 里可见（修复前 undefined） |
 * | ② | 仅用户级有 Key 时，`ModelCatalogService.resolveOverride()` 必须**能造出真适配器**而不是抛错 |
 * | ③ | 写路径**不得**把用户级凭据复制进项目文件（读分层、写仍只落项目层） |
 * | ④ | `config.get()` 摘要里凭据一律打码（原文绝不回传 UI） |
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServerConfigStore } from '../../src/server/services/serverConfigStore.js';
import { ModelCatalogService } from '../../src/server/services/modelCatalogService.js';

/** 用户级 Key（假值，绝不发网；只断言"看得见/不回显"）。 */
const USER_KEY = 'sk-user-layer-deepseek-0001';

/** 造两层配置：用户级放 Key，项目级只放 model。 */
function fixture(): {
  home: string;
  project: string;
  store: ServerConfigStore;
  configPath: string;
} {
  const home = mkdtempSync(join(tmpdir(), 'omni-store-home-'));
  const project = mkdtempSync(join(tmpdir(), 'omni-store-proj-'));
  mkdirSync(join(home, '.omniharness'), { recursive: true });
  writeFileSync(
    join(home, '.omniharness', 'omniharness.json'),
    JSON.stringify({
      modelAdapter: 'openai',
      model: 'deepseek-v4-flash',
      providerKeys: { deepseek: USER_KEY, openai: 'sk-user-layer-openai-0002' },
    }),
    'utf8',
  );
  const configPath = join(project, 'omniharness.json');
  writeFileSync(configPath, JSON.stringify({ approval: 'rules' }), 'utf8');
  const store = new ServerConfigStore({
    displayConfig: { workspace: project },
    configPath,
    autoApprove: false,
    probeProvider: () => Promise.resolve(),
    onChanged: () => undefined,
    userHomedir: home,
  });
  return { home, project, store, configPath };
}

test('① 用户级 providerKeys 在 fileConfig() 里必须可见（修复前被静默忽略）', () => {
  const { home, project, store } = fixture();
  try {
    const cfg = store.fileConfig();
    assert.strictEqual(
      cfg.providerKeys?.['deepseek'],
      USER_KEY,
      'RPC 面看不到用户级凭据 ⇒ 真模型回合会在 serve 里 fail-closed 报「未配置 API Key」',
    );
    assert.strictEqual(cfg.model, 'deepseek-v4-flash', '项目级/用户级字段都要合并进来');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('② 仅用户级有 Key 时，运行时模型重建必须成功（不得抛「未配置 API Key」）', () => {
  const { home, project, store } = fixture();
  try {
    const catalog = new ModelCatalogService({
      fileConfig: () => store.fileConfig(),
      adapterOverride: () => 'openai',
    });
    const model = catalog.resolveOverride();
    assert.ok(model !== undefined, '有凭据 + 非 mock 适配器 ⇒ 必须造出真适配器');
    assert.strictEqual(typeof model.name, 'string');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('③ 写路径只落项目层：用户级凭据不得被复制进项目文件', async () => {
  const { home, project, store, configPath } = fixture();
  try {
    await store.update({ setProviderKey: { vendor: 'deepseek', key: 'sk-project-layer-0003' } });
    const persisted = JSON.parse(readFileSync(configPath, 'utf8')) as {
      providerKeys?: Record<string, string>;
    };
    assert.strictEqual(persisted.providerKeys?.['deepseek'], 'sk-project-layer-0003');
    assert.strictEqual(
      persisted.providerKeys?.['openai'],
      undefined,
      '用户级的 openai Key 被复制进了项目文件（读分层不等于可以把用户级内容写进项目层）',
    );
    assert.ok(
      !readFileSync(configPath, 'utf8').includes(USER_KEY),
      '项目文件里不得出现用户级 Key 原文',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('④ config.get() 摘要：凭据必须打码，原文绝不回传 UI', () => {
  const { home, project, store } = fixture();
  try {
    const summary = JSON.stringify(store.get());
    assert.ok(!summary.includes(USER_KEY), 'config.get() 回显了用户级 Key 原文');
    assert.match(summary, /deepseek/, '打码后仍应能看到"该厂商已配 Key"');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('⑤ 摘要里的 workspace 必须是**实际运行根**，不被项目文件里持久化的值带偏', () => {
  // 2026-10-06 真机实测：serve 起在仓库目录，`config.get` 却回 `D:\work\新项目`（项目
  // omniharness.json 里落盘的"上次选中工作区"）⇒ 界面显示的当前工作区与实际运行的不是同一个。
  const home = mkdtempSync(join(tmpdir(), 'omni-store-home5-'));
  const project = mkdtempSync(join(tmpdir(), 'omni-store-proj5-'));
  try {
    mkdirSync(join(home, '.omniharness'), { recursive: true });
    writeFileSync(
      join(home, '.omniharness', 'omniharness.json'),
      JSON.stringify({ modelAdapter: 'openai', providerKeys: { deepseek: USER_KEY } }),
      'utf8',
    );
    const configPath = join(project, 'omniharness.json');
    // 项目文件里故意写一个**别的**持久化工作区（真实场景：UI 上次切走留下的运行时状态）。
    writeFileSync(
      configPath,
      JSON.stringify({ workspace: 'D:/some/other/project', model: 'deepseek-v4-flash' }),
      'utf8',
    );
    const store = new ServerConfigStore({
      displayConfig: { workspace: project },
      configPath,
      autoApprove: false,
      probeProvider: () => Promise.resolve(),
      onChanged: () => undefined,
      userHomedir: home,
    });
    const summary = store.get() as { workspace?: string };
    assert.strictEqual(summary.workspace, project, '摘要里的工作区必须是实际运行根');
    assert.strictEqual(
      store.fileConfig().workspace,
      'D:/some/other/project',
      '文件层的值本身仍然可读（只是不该覆盖运行时根）',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});
