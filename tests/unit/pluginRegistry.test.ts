import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  BundledSource,
  LocalDirSource,
  PluginRegistry,
  RemoteHttpSource,
} from '../../src/plugin/registry.js';
import {
  manifestHasDangerous,
  validateManifestPermissions,
  type PluginManifest,
} from '../../src/plugin/manifest.js';
import { Container } from '../../src/core/container.js';
import { PermissionDeniedError, PermissionGate } from '../../src/plugin/permissionGate.js';
import { PluginManager } from '../../src/plugin/pluginManager.js';
import type { Plugin } from '../../src/plugin/plugin.js';

/** 示范插件源码（安装后须可被 import 加载）。 */
const SAMPLE_SOURCE = `export default {
  meta: { name: 'demo-a', permissions: ['fs.read'] },
  apply(ctx) {
    ctx.registerService('plugin:demo-a', { ping: () => 'pong' });
  },
};
`;

/** 临时沙箱：samples 为「源仓库」，plugins 为「安装目录」。 */
interface Sandbox {
  readonly root: string;
  readonly samplesDir: string;
  readonly pluginsDir: string;
}

function createSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'omni-registry-'));
  const samplesDir = join(root, 'samples');
  const pluginsDir = join(root, 'plugins');
  mkdirSync(join(samplesDir, 'demo-a'), { recursive: true });
  writeFileSync(join(samplesDir, 'demo-a', 'index.js'), SAMPLE_SOURCE, 'utf8');
  mkdirSync(join(samplesDir, 'demo-b'), { recursive: true });
  writeFileSync(
    join(samplesDir, 'demo-b', 'index.js'),
    "export default { meta: { name: 'demo-b', permissions: ['net.connect'] }, apply() {} };\n",
    'utf8',
  );
  return { root, samplesDir, pluginsDir };
}

/** 打包清单（localPath 相对 samplesDir 的父级 root）。 */
function bundledManifests(): PluginManifest[] {
  return [
    {
      name: 'demo-a',
      version: '1.0.0',
      description: '演示插件 A（本地读取）',
      permissions: ['fs.read'],
      entry: 'index.js',
      source: 'bundled',
    },
    {
      name: 'demo-b',
      version: '1.2.0',
      description: '演示插件 B（联网抓取）',
      permissions: ['net.connect'],
      entry: 'index.js',
      source: 'bundled',
    },
  ];
}

/** 构造含本地+打包+不可达远程三源的注册表。 */
function createRegistry(sandbox: Sandbox): PluginRegistry {
  const bundled = bundledManifests().map((manifest, index) => ({
    ...manifest,
    localPath: index === 0 ? 'samples/demo-a' : 'samples/demo-b',
  }));
  return new PluginRegistry({
    pluginsDir: sandbox.pluginsDir,
    sources: [
      new LocalDirSource(sandbox.pluginsDir),
      new BundledSource(bundled, sandbox.root),
      // 不可达地址：验证离线优雅降级，不应影响其余源。
      new RemoteHttpSource('https://registry.invalid.example/index.json'),
    ],
  });
}

test('search 返回打包插件且远程不可达时优雅降级', async () => {
  const registry = createRegistry(createSandbox());
  const all = await registry.search();
  assert.deepStrictEqual(
    all.map((d) => d.manifest.name).sort(),
    ['demo-a', 'demo-b'],
    '远程源不可达不应中断本地与打包源',
  );
  assert.strictEqual(
    all.every((d) => d.source === 'bundled'),
    true,
  );
});

test('search 支持按名称与描述过滤', async () => {
  const registry = createRegistry(createSandbox());
  const byName = await registry.search('demo-b');
  assert.strictEqual(byName.length, 1);
  const [byNameFirst] = byName;
  assert.strictEqual(byNameFirst?.manifest.name, 'demo-b');

  const byDescription = await registry.search('联网');
  assert.strictEqual(byDescription.length, 1);
  const [byDescriptionFirst] = byDescription;
  assert.strictEqual(byDescriptionFirst?.manifest.name, 'demo-b');

  assert.strictEqual((await registry.search('不存在的插件')).length, 0);
});

test('install 复制入口并落盘权威清单与 ESM 标记', async () => {
  const sandbox = createSandbox();
  const registry = createRegistry(sandbox);
  const manifest = await registry.install('demo-a');

  assert.strictEqual(manifest.name, 'demo-a');
  assert.strictEqual(manifest.version, '1.0.0');
  const target = join(sandbox.pluginsDir, 'demo-a');
  assert.ok(existsSync(join(target, 'index.js')), '入口文件应被复制');

  const onDisk = JSON.parse(
    readFileSync(join(target, 'omni.plugin.json'), 'utf8'),
  ) as PluginManifest;
  assert.strictEqual(onDisk.name, 'demo-a');
  assert.deepStrictEqual(onDisk.permissions, ['fs.read']);

  // 无 package.json 的目录会被 Node 当作 CJS，ESM 标记是 import 成功的前提。
  const marker = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')) as {
    type?: string;
  };
  assert.strictEqual(marker.type, 'module');
});

test('list 仅返回已安装插件', async () => {
  const sandbox = createSandbox();
  const registry = createRegistry(sandbox);
  assert.deepStrictEqual(await registry.list(), [], '安装前应为空');

  await registry.install('demo-a');
  const installed = await registry.list();
  assert.strictEqual(installed.length, 1);
  const [installedFirst] = installed;
  assert.strictEqual(installedFirst?.name, 'demo-a');
});

test('remove 删除已安装插件，重复移除报错', async () => {
  const sandbox = createSandbox();
  const registry = createRegistry(sandbox);
  await registry.install('demo-a');
  await registry.remove('demo-a');
  assert.strictEqual(existsSync(join(sandbox.pluginsDir, 'demo-a')), false);

  await assert.rejects(() => registry.remove('demo-a'), /未安装插件/);
});

test('remove 拒绝移除仍被加载的插件', async () => {
  const sandbox = createSandbox();
  const registry = createRegistry(sandbox);
  await registry.install('demo-a');
  await assert.rejects(
    () => registry.remove('demo-a', () => true),
    /当前已加载/,
    '运行中实例不应被静默删除',
  );
  assert.ok(existsSync(join(sandbox.pluginsDir, 'demo-a')), '拒绝后目录应保留');
});

test('install 拒绝未知权限且不落盘半成品（fail-closed）', async () => {
  const sandbox = createSandbox();
  mkdirSync(join(sandbox.samplesDir, 'demo-bad'), { recursive: true });
  writeFileSync(join(sandbox.samplesDir, 'demo-bad', 'index.js'), 'export default {};\n', 'utf8');

  const registry = new PluginRegistry({
    pluginsDir: sandbox.pluginsDir,
    sources: [
      new LocalDirSource(sandbox.pluginsDir),
      new BundledSource(
        [
          {
            name: 'demo-bad',
            version: '0.0.1',
            description: '声明了不存在的权限',
            permissions: ['fs.universe_destroy'],
            localPath: 'samples/demo-bad',
          },
        ],
        sandbox.root,
      ),
    ],
  });

  await assert.rejects(() => registry.install('demo-bad'), /未知权限/);
  assert.strictEqual(
    existsSync(join(sandbox.pluginsDir, 'demo-bad')),
    false,
    '权限非法时绝不能留下半安装的目录',
  );
});

test('validateManifestPermissions 校验合法与非法权限', () => {
  assert.deepStrictEqual(
    validateManifestPermissions({ name: 'ok', version: '1.0.0', permissions: ['fs.read'] }),
    ['fs.read'],
  );
  assert.deepStrictEqual(validateManifestPermissions({ name: 'none', version: '1.0.0' }), []);
  assert.throws(
    () => validateManifestPermissions({ name: 'bad', version: '1.0.0', permissions: ['nope'] }),
    /未知权限/,
  );
});

test('manifestHasDangerous 标记危险权限声明', () => {
  assert.strictEqual(
    manifestHasDangerous({ name: 'a', version: '1.0.0', permissions: ['fs.read'] }),
    false,
  );
  assert.strictEqual(
    manifestHasDangerous({ name: 'b', version: '1.0.0', permissions: ['proc.exec'] }),
    true,
  );
});

test('打包示范插件可安装并经权限门禁加载（端到端闭环）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'omni-bundled-'));
  // 测试编译产物位于 dist/tests/unit/，向上三级即仓库根（examples/plugins 所在）。
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const registry = new PluginRegistry({
    pluginsDir: join(root, 'plugins'),
    bundledBaseDir: repoRoot,
  });

  const manifest = await registry.install('pdf-read');
  assert.strictEqual(manifest.name, 'pdf-read');
  assert.deepStrictEqual(manifest.permissions, ['fs.read']);

  const entry = join(root, 'plugins', 'pdf-read', manifest.entry ?? 'index.js');
  const module = (await import(pathToFileURL(entry).href)) as { default: Plugin };
  assert.strictEqual(module.default.meta.name, 'pdf-read', '安装产物应是可加载的 ESM 插件');

  // 白名单放行：可注册并启动。
  const allowed = new PluginManager(new Container(), PermissionGate.allowAll());
  await allowed.register(module.default);
  assert.strictEqual(allowed.isStarted('pdf-read'), true);

  // 默认全拒：fs.read 未在白名单，应被拦下且不残留。
  const denied = new PluginManager(new Container(), PermissionGate.denyAll());
  await assert.rejects(() => denied.register(module.default), PermissionDeniedError);
  assert.strictEqual(denied.names().includes('pdf-read'), false, '拒绝后不应残留注册');
});
