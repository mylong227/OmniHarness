import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname as pathDirname, resolve } from 'node:path';
import { FileRegistrySource, PluginRegistry } from '../../src/plugin/pluginRegistry.js';

const CATALOG = JSON.stringify({
  plugins: [
    {
      name: 'demo-notes',
      version: '0.1.0',
      description: 'catalog 独占插件',
      permissions: ['fs.read'],
      entry: 'index.js',
      localPath: 'examples/plugins/demo-notes',
    },
    {
      name: 'hello-tool',
      version: '0.1.0',
      description: '与内置重名，应被去重',
      permissions: ['fs.read'],
      entry: 'index.js',
      localPath: 'examples/plugins/hello-tool',
    },
  ],
});

test('FileRegistrySource：读取 catalog 并解析 localPath 为远程源描述符', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oh-cat-'));
  const catalog = join(dir, 'registry.json');
  writeFileSync(catalog, CATALOG);

  const src = new FileRegistrySource(catalog, dir);
  const all = await src.search();
  assert.strictEqual(all.length, 2, '应返回 2 个插件');
  const note = all.find((d) => d.manifest.name === 'demo-notes');
  assert.ok(note, '应含 demo-notes');
  assert.strictEqual(note!.source, 'remote');
  assert.strictEqual(note!.installFrom.kind, 'path');
  assert.strictEqual(note!.installFrom.path, join(dir, 'examples/plugins/demo-notes'));

  const got = await src.get('hello-tool');
  assert.ok(got, 'get 应按名取回');
  rmSync(dir, { recursive: true, force: true });
});

test('PluginRegistry：registryFile 接入后，catalog 独占插件出现在 search 且去重', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oh-reg-'));
  const pluginsDir = join(dir, 'plugins');
  mkdirSync(pluginsDir, { recursive: true });
  const catalog = join(dir, 'registry.json');
  writeFileSync(catalog, CATALOG);

  const registry = new PluginRegistry({
    pluginsDir,
    registryFile: catalog,
    registryBaseDir: resolve(pathDirname(fileURLToPath(import.meta.url)), '../../..'), // 仓库根，demo-notes 真实存在
    bundledBaseDir: dir,
  });

  const results = await registry.search();
  const names = results.map((d) => d.manifest.name);
  assert.ok(names.includes('demo-notes'), 'catalog 独占插件应出现');
  // 与内置（hello-tool 不在本测试 bundledBaseDir 下，但去重逻辑仍生效）不重复
  const dup = names.filter((n) => n === 'hello-tool');
  assert.strictEqual(dup.length, 1, 'hello-tool 应只出现一次（去重）');

  // install 走 catalog 的 localPath → 落盘到 pluginsDir
  await registry.install('demo-notes');
  assert.ok(
    existsSync(join(pluginsDir, 'demo-notes', 'omni.plugin.json')),
    'catalog 插件应能被安装到 pluginsDir',
  );
  rmSync(dir, { recursive: true, force: true });
});
