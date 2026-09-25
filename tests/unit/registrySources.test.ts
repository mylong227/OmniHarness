// F1：插件 registry 源族单测——LocalDirSource / BundledSource / RemoteHttpSource /
// FileRegistrySource 此前零测试引用。全部用临时目录与注入 fetcher，零联网：
// 既验「正常发现」，也验各源的**优雅降级**（远程不可达 / 文件缺失 / JSON 损坏 → 空数组，绝不抛）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalDirSource } from '../../src/plugin/localDirSource.js';
import { BundledSource } from '../../src/plugin/bundledSource.js';
import { RemoteHttpSource } from '../../src/plugin/remoteHttpSource.js';
import { FileRegistrySource } from '../../src/plugin/fileRegistrySource.js';
import {
  DEFAULT_REGISTRY_URL,
  RegistrySourcesShared,
} from '../../src/plugin/registrySourcesShared.js';
// 桶文件（registrySources.ts）同时导出上述四类，单独覆盖一次确保再导出面不腐坏。
import {
  LocalDirSource as BarreledLocal,
  BundledSource as BarreledBundled,
} from '../../src/plugin/registrySources.js';

/** 在临时目录内跑断言，结束后清理（异步感知：待回调完成后才删除目录）。 */
async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'reg-src-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 写一个插件子目录（含 omni.plugin.json）。 */
function writePlugin(dir: string, folder: string, manifest: Record<string, unknown>): void {
  mkdirSync(join(dir, folder), { recursive: true });
  writeFileSync(join(dir, folder, 'omni.plugin.json'), JSON.stringify(manifest), 'utf8');
}

test('LocalDirSource：扫描含清单的子目录，跳过无清单/不存在的目录', async () => {
  await withDir(async (dir) => {
    writePlugin(dir, 'alpha', { name: 'alpha-tools', version: '1.0.0', description: 'A 工具集' });
    mkdirSync(join(dir, 'no-manifest'), { recursive: true });
    writeFileSync(join(dir, 'loose.txt'), 'x', 'utf8');

    const source = new LocalDirSource(dir);
    assert.strictEqual(source.kind, 'local');
    const all = await source.search();
    assert.strictEqual(all.length, 1);
    assert.strictEqual(all[0]!.manifest.name, 'alpha-tools');
    assert.strictEqual(all[0]!.source, 'local');
    assert.deepStrictEqual(all[0]!.installFrom, { kind: 'path', path: join(dir, 'alpha') });
  });
});

test('LocalDirSource：目录不存在时返回空（不抛）', async () => {
  await withDir(async (dir) => {
    const source = new LocalDirSource(join(dir, 'ghost'));
    assert.deepStrictEqual(await source.search(), []);
  });
});

test('LocalDirSource：查询按名称/描述大小写不敏感过滤；get 按唯一名取', async () => {
  await withDir(async (dir) => {
    writePlugin(dir, 'a', { name: 'alpha-tools', version: '1.0.0', description: '文件工具' });
    writePlugin(dir, 'b', { name: 'beta-tools', version: '2.0.0', description: 'Git 集成' });
    const source = new LocalDirSource(dir);

    assert.strictEqual((await source.search('ALPHA')).length, 1);
    assert.strictEqual((await source.search('git')).length, 1, '应命中描述');
    assert.strictEqual((await source.search('zzz')).length, 0);
    assert.strictEqual((await source.search()).length, 2, '空查询=全量');

    assert.strictEqual((await source.get('beta-tools'))?.manifest.version, '2.0.0');
    assert.strictEqual(await source.get('ghost'), undefined);
  });
});

test('BundledSource：本地路径优先于下载地址；两者皆无则不产出描述符', async () => {
  await withDir(async (dir) => {
    const source = new BundledSource(
      [
        { name: 'has-path', version: '1.0.0', localPath: 'plugins/has-path' },
        { name: 'has-url', version: '1.0.0', downloadUrl: 'https://x/y.zip' },
        { name: 'neither', version: '1.0.0' },
      ],
      dir,
    );
    assert.strictEqual(source.kind, 'bundled');
    const all = await source.search();
    assert.strictEqual(all.length, 2);
    const byPath = all.find((d) => d.manifest.name === 'has-path');
    assert.deepStrictEqual(byPath?.installFrom, {
      kind: 'path',
      path: join(dir, 'plugins/has-path'),
    });
    const byUrl = all.find((d) => d.manifest.name === 'has-url');
    assert.deepStrictEqual(byUrl?.installFrom, { kind: 'url', url: 'https://x/y.zip' });
    // 描述符里不应残留 localPath / downloadUrl 字段（已剥离为安装来源）。
    assert.strictEqual('localPath' in (byUrl?.manifest ?? {}), false);
  });
});

test('BundledSource：查询过滤与 get 检索', async () => {
  await withDir(async (dir) => {
    const source = new BundledSource(
      [
        { name: 'alpha', version: '1.0.0', description: '文件', localPath: 'a' },
        { name: 'beta', version: '1.0.0', description: '网络', localPath: 'b' },
      ],
      dir,
    );
    assert.strictEqual((await source.search('网络')).length, 1);
    assert.strictEqual((await source.get('alpha'))?.manifest.name, 'alpha');
    assert.strictEqual(await source.get('nope'), undefined);
  });
});

test('RemoteHttpSource：解析索引；installFrom 取 downloadUrl，缺省回落索引地址', async () => {
  const source = new RemoteHttpSource('https://idx/index.json', async () => ({
    plugins: [
      { name: 'r1', version: '1.0.0', downloadUrl: 'https://dl/r1.zip' },
      { name: 'r2', version: '2.0.0' },
      { name: 'bad', version: 3 },
    ],
  }));
  assert.strictEqual(source.kind, 'remote');
  const all = await source.search();
  assert.strictEqual(all.length, 2, '缺 name/version 的条目应被跳过');
  assert.deepStrictEqual(all[0]!.installFrom, { kind: 'url', url: 'https://dl/r1.zip' });
  assert.deepStrictEqual(all[1]!.installFrom, { kind: 'url', url: 'https://idx/index.json' });
});

test('RemoteHttpSource：拉取失败/结构异常一律降级为空数组（离线可用是硬要求）', async () => {
  const boom = new RemoteHttpSource('https://idx', async () => {
    throw new Error('网络不可达');
  });
  assert.deepStrictEqual(await boom.search(), []);
  assert.strictEqual(await boom.get('r1'), undefined);

  const notArray = new RemoteHttpSource('https://idx', async () => ({ plugins: 'oops' }));
  assert.deepStrictEqual(await notArray.search(), []);

  const nullish = new RemoteHttpSource('https://idx', async () => null);
  assert.deepStrictEqual(await nullish.search(), []);
});

test('RemoteHttpSource：查询过滤（复用注入索引，不重复联网语义）', async () => {
  const source = new RemoteHttpSource('https://idx', async () => ({
    plugins: [
      { name: 'alpha', version: '1.0.0', description: '文件工具' },
      { name: 'beta', version: '1.0.0', description: '网络工具' },
    ],
  }));
  assert.strictEqual((await source.search('网络')).length, 1);
  assert.strictEqual((await source.get('beta'))?.manifest.name, 'beta');
});

test('FileRegistrySource：localPath 相对 baseDir 解析，downloadUrl/缺省走 URL', async () => {
  await withDir(async (dir) => {
    const catalog = join(dir, 'registry.json');
    writeFileSync(
      catalog,
      JSON.stringify({
        plugins: [
          { name: 'local-one', version: '1.0.0', localPath: 'plugins/local-one' },
          { name: 'url-one', version: '1.0.0', downloadUrl: 'https://dl/u.zip' },
          { name: 'bare', version: '1.0.0' },
          { name: 'bad', version: 1 },
        ],
      }),
      'utf8',
    );
    const source = new FileRegistrySource(catalog, dir);
    assert.strictEqual(source.kind, 'remote');
    const all = await source.search();
    assert.strictEqual(all.length, 3);
    const local = all.find((d) => d.manifest.name === 'local-one');
    assert.deepStrictEqual(local?.installFrom, {
      kind: 'path',
      path: join(dir, 'plugins/local-one'),
    });
    const bare = all.find((d) => d.manifest.name === 'bare');
    assert.deepStrictEqual(bare?.installFrom, { kind: 'url', url: catalog });
    // 剥离 localPath/downloadUrl 后不应残留到 manifest。
    assert.strictEqual('localPath' in (local?.manifest ?? {}), false);
  });
});

test('FileRegistrySource：缺文件/JSON 损坏/结构异常一律降级空数组', async () => {
  await withDir(async (dir) => {
    assert.deepStrictEqual(await new FileRegistrySource(join(dir, 'ghost.json')).search(), []);

    const broken = join(dir, 'broken.json');
    writeFileSync(broken, '{ not json', 'utf8');
    assert.deepStrictEqual(await new FileRegistrySource(broken).search(), []);

    const notArray = join(dir, 'bad.json');
    writeFileSync(notArray, JSON.stringify({ plugins: 42 }), 'utf8');
    assert.deepStrictEqual(await new FileRegistrySource(notArray).search(), []);
  });
});

test('共享工具：readManifest / safeReaddir / textOf 的行为契约', async () => {
  await withDir(async (dir) => {
    writePlugin(dir, 'p', { name: 'p', version: '1.0.0' });
    assert.strictEqual(
      RegistrySourcesShared.readManifest(join(dir, 'p', 'omni.plugin.json')).name,
      'p',
    );
    assert.deepStrictEqual(RegistrySourcesShared.safeReaddir(join(dir, 'p')).sort(), [
      'omni.plugin.json',
    ]);
    assert.deepStrictEqual(
      RegistrySourcesShared.safeReaddir(join(dir, 'ghost')),
      [],
      '不存在的目录返回空数组',
    );
    assert.strictEqual(RegistrySourcesShared.textOf(new Error('boom')), 'boom');
    assert.strictEqual(RegistrySourcesShared.textOf('plain'), 'plain', '非 Error 一律 String 化');
  });
});

test('默认索引地址可由环境变量覆盖（模块加载期读取）', () => {
  assert.strictEqual(typeof DEFAULT_REGISTRY_URL, 'string');
  assert.ok(DEFAULT_REGISTRY_URL.length > 0);
});

test('桶文件 registrySources.ts 正确再导出四类源', () => {
  assert.strictEqual(BarreledLocal, LocalDirSource);
  assert.strictEqual(BarreledBundled, BundledSource);
});
