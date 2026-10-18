import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServerConfigStore } from '../../src/server/services/serverConfigStore.ts';
import { configFile } from '../../src/config/configFile.ts';
import { ProviderPresets } from '../../src/server/services/providerPresets.ts';

/**
 * 在临时工作区内构造配置存储并执行。
 *
 * 必须注入隔离的 `userHomedir`（2026-10-06）：`workspace`/`workspaces` 属**本机运行态**，只落
 * 用户级配置；不注入就会读写**真实**的 `~/.omniharness/omniharness.json`——既污染开发机，
 * 也让断言被真实配置里的项目列表带偏（非封闭测试）。
 */
function withStore<T>(
  fn: (ws: string, store: ServerConfigStore, home: string) => T | Promise<T>,
): Promise<T> {
  const ws = mkdtempSync(join(tmpdir(), 'cfg-store-'));
  const home = mkdtempSync(join(tmpdir(), 'cfg-store-home-'));
  const store = new ServerConfigStore({
    displayConfig: { workspace: ws },
    configPath: join(ws, 'omniharness.json'),
    autoApprove: false,
    probeProvider: async () => {},
    onChanged: () => {},
    userHomedir: home,
  });
  return Promise.resolve(fn(ws, store, home)).finally(() => {
    rmSync(ws, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
}

test('ServerConfigStore.get：合并展示字段与 autoApprove', async () => {
  await withStore((ws, store) => {
    const out = store.get() as { workspace: string; autoApprove: boolean };
    assert.strictEqual(out.workspace, ws);
    assert.strictEqual(out.autoApprove, false);
  });
});

test('ServerConfigStore.update：autoApprove 生效并随摘要回传', async () => {
  await withStore(async (_ws, store) => {
    const res = (await store.update({ autoApprove: true })) as {
      autoApprove: boolean;
      ok: boolean;
    };
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.autoApprove, true);
    assert.strictEqual(store.autoApprove, true);
    assert.strictEqual((store.get() as { autoApprove: boolean }).autoApprove, true);
  });
});

test('ServerConfigStore.update：`null` 显式清除覆盖，且不会从旧文件里被复活', async () => {
  await withStore(async (_ws, store, home) => {
    const savedPath = join(home, '.omniharness', configFile.FILE_NAME);
    await store.update({ baseUrl: 'https://proxy.example/v1' });
    assert.match(configFile.load(savedPath).baseUrl ?? '', /proxy\.example/, '先写入覆盖');

    await store.update({ baseUrl: null });
    const after = store.get() as { baseUrl?: string };
    assert.strictEqual(after.baseUrl, undefined, '清除后展示值必须回落（不再是覆盖值）');
    assert.strictEqual(
      configFile.load(savedPath).baseUrl,
      undefined,
      '落盘结果里也必须消失（mergeConfigs 只覆盖不删除，容易把旧值复活）',
    );
  });
});

test('ServerConfigStore.get：apiKey 与 providerKeys 一律打码，原文不回传', async () => {
  await withStore(async (_ws, store) => {
    const raw = 'sk-abcdefghijklmn';
    await store.update({ apiKey: raw, providerKeys: { deepseek: 'sk-deepseek-secret' } });
    const out = store.get() as { apiKey: string; providerKeys: Record<string, string> };
    assert.strictEqual(out.apiKey, ProviderPresets.maskKey(raw));
    assert.ok(!out.apiKey.includes('efghijkl'), '打码后不得含原文中段');
    assert.strictEqual(out.providerKeys['deepseek'], ProviderPresets.maskKey('sk-deepseek-secret'));
  });
});

test('ServerConfigStore.update：approval / modelAdapter 覆盖可被读取', async () => {
  await withStore(async (_ws, store) => {
    assert.strictEqual(store.approvalOverride(), undefined);
    await store.update({ approval: 'auto', modelAdapter: 'openai' });
    assert.strictEqual(store.approvalOverride(), 'auto');
    assert.strictEqual(store.adapterOverride(), 'openai');
  });
});

test('ServerConfigStore.update：覆盖字段实时并入 fileConfig 并落盘到用户级', async () => {
  await withStore(async (ws, store, home) => {
    const projectPath = join(ws, configFile.FILE_NAME);
    const userPath = join(home, '.omniharness', configFile.FILE_NAME);
    await store.update({ model: 'm-1' });
    assert.strictEqual(store.fileConfig().model, 'm-1');
    assert.ok(existsSync(userPath), '应写出用户级配置文件');
    assert.strictEqual(configFile.load(userPath).model, 'm-1');
    assert.strictEqual(
      configFile.load(projectPath).model,
      undefined,
      '项目文件只读不写——设置不得再落回工作区目录',
    );
  });
});

test('ServerConfigStore.requireDirectory：空值 / 不存在 fail-closed', async () => {
  await withStore((ws, store) => {
    assert.throws(() => store.requireDirectory(''), /路径不能为空/);
    assert.throws(() => store.requireDirectory(undefined), /路径不能为空/);
    assert.throws(() => store.requireDirectory(join(ws, 'ghost')), /目录不存在或不是文件夹/);
    assert.strictEqual(store.requireDirectory(ws), ws);
  });
});

test('ServerConfigStore.addWorkspace：去重并并入工作区列表', async () => {
  await withStore(async (ws, store) => {
    const first = store.addWorkspace(ws) as { current: string; workspaces: string[] };
    assert.strictEqual(first.current, ws);
    assert.deepEqual(first.workspaces, [ws]);
    const again = store.addWorkspace(ws) as { workspaces: string[] };
    assert.deepEqual(again.workspaces, [ws], '重复添加不应产生重复项');
  });
});

test('ServerConfigStore.commitWorkspaceSwitch：旧工作区一并收编进列表', async () => {
  await withStore(async (ws, store) => {
    const target = join(ws, 'sub');
    const out = store.commitWorkspaceSwitch(target, ws);
    assert.strictEqual(out.current, target);
    assert.deepEqual([...out.workspaces].sort(), [target, ws].sort());
    assert.strictEqual(store.workspace(), target);
  });
});

test('ServerConfigStore.persist：写路径恒为用户级文件（不随工作区/启动目录漂移）', async () => {
  await withStore(async (ws, store, home) => {
    store.persist();
    assert.ok(existsSync(join(home, '.omniharness', configFile.FILE_NAME)));
    assert.ok(!existsSync(join(ws, configFile.FILE_NAME)), '项目目录不得被写出新配置文件');
  });
});

test('ServerConfigStore.update：凭据只落用户级，绝不进项目文件', async () => {
  await withStore(async (ws, store, home) => {
    const projectPath = join(ws, configFile.FILE_NAME);
    const userPath = join(home, '.omniharness', configFile.FILE_NAME);
    await store.update({ apiKey: 'sk-top-secret', providerKeys: { deepseek: 'sk-ds-secret' } });

    const userFile = configFile.load(userPath);
    assert.strictEqual(userFile.apiKey, 'sk-top-secret', 'apiKey 必须落用户级');
    assert.strictEqual(userFile.providerKeys?.['deepseek'], 'sk-ds-secret');
    const projectFile = configFile.load(projectPath);
    assert.strictEqual(projectFile.apiKey, undefined, '项目文件绝不能出现 apiKey');
    assert.strictEqual(projectFile.providerKeys, undefined, '项目文件绝不能出现 providerKeys');

    // 运行时读取（分层合并）仍可见
    assert.strictEqual(store.fileConfig().apiKey, 'sk-top-secret');
  });
});

test('ServerConfigStore.update：换工作区后凭据依旧可见（重启重置回归）', async () => {
  await withStore(async (_ws, store, home) => {
    await store.update({ providerKeys: { deepseek: 'sk-ds-secret' } });
    // 模拟重启后工作区解析到另一个目录：换一份 displayConfig（新工作区、同一用户级 home）。
    const ws2 = mkdtempSync(join(tmpdir(), 'cfg-store-ws2-'));
    try {
      const reborn = new ServerConfigStore({
        displayConfig: { workspace: ws2 },
        configPath: join(ws2, 'omniharness.json'),
        autoApprove: false,
        probeProvider: async () => {},
        onChanged: () => {},
        userHomedir: home,
      });
      assert.strictEqual(
        reborn.fileConfig().providerKeys?.['deepseek'],
        'sk-ds-secret',
        '重启换工作区后 Key 必须仍然生效',
      );
    } finally {
      rmSync(ws2, { recursive: true, force: true });
    }
  });
});

test('ServerConfigStore.update：`null` 清除凭据从用户级文件删除，且不复活', async () => {
  await withStore(async (_ws, store, home) => {
    await store.update({ providerKeys: { deepseek: 'sk-ds-secret' } });
    await store.update({ providerKeys: null });
    const userPath = join(home, '.omniharness', configFile.FILE_NAME);
    assert.strictEqual(
      configFile.load(userPath).providerKeys,
      undefined,
      '清除后用户级落盘结果里也必须消失',
    );
    assert.strictEqual(store.fileConfig().providerKeys, undefined);
  });
});

test('ServerConfigStore.update：permission 规则可持久化，非法规则 fail-closed', async () => {
  await withStore(async (_ws, store, home) => {
    await store.update({
      permission: { rules: [{ toolName: 'shell', commandGlob: '*curl *', decision: 'deny' }] },
    });
    const persisted = configFile.load(join(home, '.omniharness', configFile.FILE_NAME));
    assert.strictEqual(persisted.permission?.rules?.[0]?.commandGlob, '*curl *');
    // 非法裁决经 normalizeConfig 拒绝（fail-closed），不得静默落盘
    await assert.rejects(
      store.update({ permission: { rules: [{ decision: 'maybe' }] } }),
      /permission/,
    );
  });
});
