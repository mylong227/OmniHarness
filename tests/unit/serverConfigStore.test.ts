import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServerConfigStore } from '../../src/server/serverConfigStore.js';
import { ConfigFile } from '../../src/config/configFile.js';
import { maskKey } from '../../src/server/providerPresets.js';

/** 在临时工作区内构造配置存储并执行。 */
function withStore<T>(fn: (ws: string, store: ServerConfigStore) => T | Promise<T>): Promise<T> {
  const ws = mkdtempSync(join(tmpdir(), 'cfg-store-'));
  const store = new ServerConfigStore({
    displayConfig: { workspace: ws },
    autoApprove: false,
    probeProvider: async () => {},
    onChanged: () => {},
  });
  return Promise.resolve(fn(ws, store)).finally(() => rmSync(ws, { recursive: true, force: true }));
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
    const res = (await store.update({ autoApprove: true })) as { autoApprove: boolean; ok: boolean };
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.autoApprove, true);
    assert.strictEqual(store.autoApprove, true);
    assert.strictEqual((store.get() as { autoApprove: boolean }).autoApprove, true);
  });
});

test('ServerConfigStore.get：apiKey 与 providerKeys 一律打码，原文不回传', async () => {
  await withStore(async (_ws, store) => {
    const raw = 'sk-abcdefghijklmn';
    await store.update({ apiKey: raw, providerKeys: { deepseek: 'sk-deepseek-secret' } });
    const out = store.get() as { apiKey: string; providerKeys: Record<string, string> };
    assert.strictEqual(out.apiKey, maskKey(raw));
    assert.ok(!out.apiKey.includes('efghijkl'), '打码后不得含原文中段');
    assert.strictEqual(out.providerKeys['deepseek'], maskKey('sk-deepseek-secret'));
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

test('ServerConfigStore.update：覆盖字段实时并入 fileConfig 并落盘', async () => {
  await withStore(async (ws, store) => {
    await store.update({ model: 'm-1' });
    assert.strictEqual(store.fileConfig().model, 'm-1');
    assert.ok(existsSync(join(ws, ConfigFile.FILE_NAME)), '应写出项目配置文件');
    assert.strictEqual(ConfigFile.load(join(ws, ConfigFile.FILE_NAME)).model, 'm-1');
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

test('ServerConfigStore：未提供 configPath 时按工作区推断落盘路径', async () => {
  await withStore((ws, store) => {
    store.persist();
    assert.ok(existsSync(join(ws, ConfigFile.FILE_NAME)));
  });
});
