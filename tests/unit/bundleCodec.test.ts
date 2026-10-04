/**
 * `BundleCodec` 判据（G2 验签与 H1 评级**共用**的 zip-store 读取器）。
 *
 * ## 为什么这份判据重要
 *
 * "读包"是所有分发/评级动作的入口：读到的内容与打包器写的不一致，会让**验签**与**静态扫描**
 * 同时失去意义（一个按未签名处理、一个扫不到 `eval`）。故这里把"与打包器往返一致"
 * 与"畸形包可读拒"两类钉死，且**畸形包必须给可读原因**（不是抛异常、也不是当空包）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BundleCodec, BUNDLE_MANIFEST_ENTRY } from '../../src/plugin/bundleCodec.js';
import { PluginBundler } from '../../src/plugin/pluginBundler.js';

/**
 * 手工构造一个 zip-store 包（可控内容，用于畸形包判据）。
 * @param entries 条目名与内容
 * @param options 压缩方式字段（默认 0 = store）
 * @returns zip 字节
 */
function zipStore(
  entries: readonly (readonly [string, string])[],
  options: { readonly method?: number | undefined } = {},
): Buffer {
  const chunks: Buffer[] = [];
  for (const [name, content] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(options.method ?? 0, 8);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt16LE(nameBytes.length, 26);
    chunks.push(header, nameBytes, data);
  }
  return Buffer.concat(chunks);
}

/**
 * 写一个临时包文件。
 * @param bytes 内容
 * @param name 文件名
 * @returns 路径
 */
function writeZip(bytes: Buffer, name = 'x.ohb'): string {
  const dir = mkdtempSync(join(tmpdir(), 'codec-'));
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

test('BundleCodec：与打包器**往返一致**（清单与插件文件都能读回，逐字节可比）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codec-rt-'));
  const pluginDir = join(root, 'plugins-src', 'demo');
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, 'index.js'), 'module.exports = { run: () => 1 };\n', 'utf8');
  const outDir = join(root, 'out');
  mkdirSync(outDir, { recursive: true });
  const packed = await new PluginBundler().packBundle({
    workspaceDir: join(root, 'ws'),
    profile: { name: 'rt', plugins: ['demo'], config: { k: 'v' } },
    registry: {
      get: () =>
        Promise.resolve({
          name: 'demo',
          source: 'path',
          installFrom: { kind: 'path', path: pluginDir },
        }),
      list: () => Promise.resolve([]),
    } as never,
    pluginsDir: join(root, 'plugins'),
    outDir,
  });

  const read = BundleCodec.readFiles(packed.path);
  assert.strictEqual(read.ok, true, read.ok ? '' : read.reason);
  if (!read.ok) return;
  assert.ok(read.files.has(BUNDLE_MANIFEST_ENTRY), '必须能读回清单');
  assert.ok(
    [...read.files.keys()].some((name) => name.endsWith('index.js')),
    `必须能读回插件入口，实际条目：${[...read.files.keys()].join(', ')}`,
  );
  const manifest = BundleCodec.readManifestJson(packed.path);
  assert.strictEqual(manifest.ok, true);
  if (manifest.ok) {
    assert.deepStrictEqual((manifest.json as { name: string }).name, 'rt');
  }
  // 往返一致的关键：读回的清单文本与打包器写盘时的一致（逐字符）。
  assert.strictEqual(
    read.files.get(BUNDLE_MANIFEST_ENTRY),
    `${JSON.stringify(packed.manifest, null, 2)}\n`,
  );
});

test('BundleCodec：缺清单 / 非 zip / 截断 / 非 store 压缩 ⇒ 可读拒（不抛、不当空包）', () => {
  // ① 缺清单。
  const noManifest = BundleCodec.readManifestJson(writeZip(zipStore([['index.js', 'x']])));
  assert.strictEqual(noManifest.ok, false);
  if (!noManifest.ok) assert.match(noManifest.reason, /缺 bundle\.json 清单/);

  // ② 非 zip：连本地文件头都没有。
  const notZip = BundleCodec.readFiles(writeZip(Buffer.from('not a zip at all'), 'bad.ohb'));
  assert.strictEqual(notZip.ok, false);
  if (!notZip.ok) assert.match(notZip.reason, /不是合法的 \.ohb/);

  // ③ 截断：头声明的内容长度超出文件实际长度。
  const full = zipStore([['a.js', 'abcdefghij']]);
  const truncated = BundleCodec.readFiles(writeZip(full.subarray(0, full.length - 4), 'trunc.ohb'));
  assert.strictEqual(truncated.ok, false);
  if (!truncated.ok) assert.match(truncated.reason, /长度越界|不是合法的 \.ohb/);

  // ④ 非 store 压缩方式：本仓只产 store，遇到别的**如实说**而不是假装能解。
  const deflated = BundleCodec.readFiles(writeZip(zipStore([['a.js', 'x']], { method: 8 })));
  assert.strictEqual(deflated.ok, false);
  if (!deflated.ok) assert.match(deflated.reason, /压缩方式 8/);

  // ⑤ 清单不是合法 JSON。
  const badJson = BundleCodec.readManifestJson(
    writeZip(zipStore([[BUNDLE_MANIFEST_ENTRY, '{oops']])),
  );
  assert.strictEqual(badJson.ok, false);
  if (!badJson.ok) assert.match(badJson.reason, /不是合法 JSON/);
});

test('BundleCodec：多条目按顺序读全（条目顺序不影响结果），空内容条目也保留', () => {
  const path = writeZip(
    zipStore([
      [BUNDLE_MANIFEST_ENTRY, '{"name":"m"}'],
      ['plugins/a/index.js', ''],
      ['plugins/b/index.js', 'module.exports = {};'],
    ]),
  );
  const read = BundleCodec.readFiles(path);
  assert.strictEqual(read.ok, true);
  if (!read.ok) return;
  assert.deepStrictEqual(
    [...read.files.keys()],
    [BUNDLE_MANIFEST_ENTRY, 'plugins/a/index.js', 'plugins/b/index.js'],
  );
  assert.strictEqual(read.files.get('plugins/a/index.js'), '', '空内容条目必须保留（不是"缺失"）');
});

test('BundleCodec：文件不存在 ⇒ 可读拒（不是抛异常）', () => {
  const read = BundleCodec.readFiles(join(tmpdir(), 'definitely-missing-bundle.ohb'));
  assert.strictEqual(read.ok, false);
  if (!read.ok) assert.match(read.reason, /无法读取包文件/);
});
