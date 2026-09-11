import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packBundle, unpackBundle } from '../../src/plugin/pluginBundler.js';
import type { PluginRegistry } from '../../src/plugin/pluginRegistry.js';
import type { PluginProfile } from '../../src/plugin/pluginProfileStore.js';

/** 构造最小 registry stub：所有插件均来自本地目录。 */
function makeRegistry(pluginPath: string): PluginRegistry {
  return {
    async get(name: string) {
      return {
        name,
        source: 'bundled',
        installFrom: { kind: 'path', path: pluginPath },
        manifest: { name },
      } as never;
    },
  } as unknown as PluginRegistry;
}

test('bundle pack → unpack 往返：插件还原 + 补丁层写出', async () => {
  const base = mkdtempSync(join(tmpdir(), 'ohb-'));
  try {
    const pluginDir = join(base, 'myplugin');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'omni.plugin.json'), JSON.stringify({ name: 'myplugin' }));
    writeFileSync(join(pluginDir, 'index.js'), 'module.exports = {};');

    const workspaceDir = join(base, 'ws');
    mkdirSync(workspaceDir, { recursive: true });
    const pluginsDir = join(base, 'plugins');
    mkdirSync(pluginsDir, { recursive: true });

    const profile: PluginProfile = { name: 'demo', plugins: ['myplugin'], config: { maxSteps: 8 } };
    const packed = await packBundle({
      workspaceDir,
      profile,
      registry: makeRegistry(pluginDir),
      pluginsDir,
    });
    assert.ok(existsSync(packed.path), 'ohb 文件应已生成');
    assert.strictEqual(packed.manifest.plugins.length, 1);

    const outPlugins = join(base, 'out');
    mkdirSync(outPlugins, { recursive: true });
    const unpacked = await unpackBundle({
      zipPath: packed.path,
      pluginsDir: outPlugins,
      workspaceDir,
    });
    assert.deepStrictEqual(unpacked.installed, ['myplugin']);
    assert.ok(existsSync(join(outPlugins, 'myplugin', 'index.js')), '插件文件应被还原');
    assert.ok(existsSync(unpacked.patchFile), '补丁层文件应写出');
    const patch = JSON.parse(readFileSync(unpacked.patchFile, 'utf8'));
    assert.strictEqual(patch.patches[0].key, 'maxSteps');
    assert.strictEqual(patch.patches[0].value, 8);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('bundle HMAC 签名：同密钥可校验，异密钥拒绝', async () => {
  const base = mkdtempSync(join(tmpdir(), 'ohb2-'));
  try {
    const pluginDir = join(base, 'p');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'f.txt'), 'x');

    const workspaceDir = join(base, 'ws');
    mkdirSync(workspaceDir, { recursive: true });
    const pluginsDir = join(base, 'plugins');
    mkdirSync(pluginsDir, { recursive: true });
    const keyFile = join(base, 'key.hex');

    const profile: PluginProfile = { name: 'signed', plugins: ['p'] };
    const packed = await packBundle({
      workspaceDir,
      profile,
      registry: makeRegistry(pluginDir),
      pluginsDir,
      keyFile,
    });
    assert.ok(packed.manifest.signature !== undefined, '应带签名');

    const out1 = join(base, 'out1');
    mkdirSync(out1, { recursive: true });
    await assert.doesNotReject(
      unpackBundle({ zipPath: packed.path, pluginsDir: out1, workspaceDir, keyFile }),
    );

    const out2 = join(base, 'out2');
    mkdirSync(out2, { recursive: true });
    const badKey = join(base, 'badkey.hex');
    writeFileSync(badKey, '00'.repeat(32));
    await assert.rejects(
      unpackBundle({ zipPath: packed.path, pluginsDir: out2, workspaceDir, keyFile: badKey }),
      /签名校验失败/,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
