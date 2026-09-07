import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PluginProfileStore,
  sanitizeProfileName,
  applyProfile,
  type PluginProfile,
} from '../../src/plugin/pluginProfile.js';
import type { PluginManager } from '../../src/plugin/pluginManager.js';
import type { PluginRegistry } from '../../src/plugin/registry.js';

test('sanitizeProfileName 归一化', () => {
  assert.strictEqual(sanitizeProfileName('My Profile! @v2'), 'my-profile-v2');
  assert.strictEqual(sanitizeProfileName(''), 'unnamed');
});

test('PluginProfileStore save/list/get/delete + 坏文件跳过', () => {
  const root = mkdtempSync(join(tmpdir(), 'pf-'));
  try {
    const store = new PluginProfileStore(root);
    assert.deepStrictEqual(store.list(), []);
    const id = store.save({ name: 'Web Dev', plugins: ['a', 'b'], description: 'd' });
    assert.strictEqual(id, 'web-dev');
    const list = store.list();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0]!.pluginCount, 2);
    const got = store.get(id);
    assert.strictEqual(got?.name, 'Web Dev');
    assert.ok(store.delete(id));
    assert.strictEqual(store.get(id), undefined);
    // 坏文件在 list 中被跳过（fail-closed 不阻塞）
    mkdirSync(join(root, '.omniharness', 'pluginProfiles'), { recursive: true });
    writeFileSync(join(root, '.omniharness', 'pluginProfiles', 'broken.json'), '{not json');
    assert.deepStrictEqual(store.list(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('applyProfile 卸载目标集之外的插件', async () => {
  const uninstalled: string[] = [];
  const fakeManager = {
    names: () => ['a', 'b'],
    uninstall: async (n: string) => {
      uninstalled.push(n);
    },
  } as unknown as PluginManager;
  const fakeRegistry = {
    get: async () => undefined,
    install: async () => {},
  } as unknown as PluginRegistry;
  const profile: PluginProfile = { name: 'p', plugins: ['a'] };
  const result = await applyProfile(fakeManager, '/tmp/x', fakeRegistry, profile);
  assert.deepStrictEqual(result.deactivated, ['b']);
  assert.deepStrictEqual(result.missing, []);
  assert.deepStrictEqual(uninstalled, ['b']);
});

test('applyProfile 引用无法解析的插件时 fail-closed 抛错', async () => {
  const fakeManager = {
    names: () => [],
    uninstall: async () => {},
  } as unknown as PluginManager;
  const fakeRegistry = {
    get: async () => undefined,
    install: async () => {
      throw new Error('no such plugin');
    },
  } as unknown as PluginRegistry;
  const profile: PluginProfile = { name: 'p', plugins: ['ghost'] };
  await assert.rejects(
    () => applyProfile(fakeManager, '/tmp/x', fakeRegistry, profile),
    /无法激活/,
  );
});
