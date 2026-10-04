/**
 * G2（签名私有技能源）判据 —— 商业化报告 §5 阶段 2 原文：
 * 「`bundle pack/unpack`（已有 .ohb + HMAC）升级为带签名的私有技能源；
 * **判据：无签名包在严格档被拒（红）**」。
 *
 * ## 判据逐条对应
 *
 * | # | 判据 | 怎么判 |
 * | --- | --- | --- |
 * | ① | **无签名包在严格档被拒**（原文红线） | 严格源 + 无签名 `.ohb` ⇒ `accepted:false`、原因点名"严格档要求 Ed25519 签名"、且**安装回调零调用** |
 * | ② | 仅 HMAC 也不算凭据 | HMAC 签名的包在严格档同样拒（HMAC 对称：能验者即可伪造），原因明说这一点 |
 * | ③ | 签名有效但**不在信任根** ⇒ 拒 | 用第二把密钥签的包 ⇒ 拒，原因点名"不在信任根内" |
 * | ④ | **篡改内容** ⇒ 拒 | 签名后改清单（版本/插件表）⇒ 验签失败 ⇒ 拒 |
 * | ⑤ | 宽松档**不静默提档** | 无签名包在宽松档被接收，但 `tier:'community'`（绝不是 `verified`） |
 * | ⑥ | 只装放行集 | `sync()` 只对 `accepted` 的包调用安装回调；被拒的一个都不装 |
 *
 * 夹具用**真 Ed25519 密钥对**与**真 `.ohb` 字节流**（走 `PluginBundler.packBundle`），
 * 不 mock 验签、不 mock zip——否则"拒了"可能只是夹具自己写错了。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PrivateSkillSource } from '../../src/plugin/privateSkillSource.js';
import { PluginBundler } from '../../src/plugin/pluginBundler.js';
import { Ed25519AgentIdentity } from '../../src/adapters/identity/ed25519AgentIdentity.js';
import { Ed25519PublicKey } from '../../src/util/ed25519PublicKey.js';
import type { BundleManifest } from '../../src/plugin/pluginBundler.js';

/** 发布者身份（真密钥）。 */
const PUBLISHER = new Ed25519AgentIdentity({ agentRuntimeId: 'publisher' });
/** 另一把密钥（冒充者 / 非信任根）。 */
const STRANGER = new Ed25519AgentIdentity({ agentRuntimeId: 'stranger' });

/**
 * 造一个 `.ohb` 包（可选签名）。
 * @param dir 输出目录
 * @param name 包名
 * @param opts 是否带 Ed25519 / HMAC 签名
 * @returns 包路径
 */
async function makeBundle(
  dir: string,
  name: string,
  opts: {
    readonly ed25519?: Ed25519AgentIdentity | undefined;
    readonly hmac?: boolean | undefined;
  } = {},
): Promise<string> {
  const workspace = join(dir, `ws-${name}`);
  mkdirSync(join(workspace, '.omniharness'), { recursive: true });
  const outDir = join(dir, 'out');
  mkdirSync(outDir, { recursive: true });
  const bundler = new PluginBundler();
  const result = await bundler.packBundle({
    workspaceDir: workspace,
    profile: { name, plugins: [], config: { k: name } },
    registry: {
      get: () => Promise.resolve(undefined),
      list: () => Promise.resolve([]),
    } as never,
    pluginsDir: join(workspace, 'plugins'),
    outDir,
    ...(opts.ed25519 !== undefined ? { identity: opts.ed25519 } : {}),
    ...(opts.hmac === true ? { keyFile: join(workspace, 'bundle.key') } : {}),
  });
  return result.path;
}

/**
 * 把包放进源目录。
 * @param sourceDir 源目录
 * @param bundlePath 包路径
 * @param asName 目标文件名
 * @returns 目标路径
 */
function place(sourceDir: string, bundlePath: string, asName: string): string {
  mkdirSync(sourceDir, { recursive: true });
  const target = join(sourceDir, asName);
  renameSync(bundlePath, target);
  return target;
}

/**
 * 造一个"源"，带安装回调计数。
 * @param sourceDir 源目录
 * @param strict 是否严格档
 * @param trusted 信任根
 * @returns 源与安装记录
 */
function makeSource(
  sourceDir: string,
  strict: boolean,
  trusted: readonly string[],
): { readonly source: PrivateSkillSource; readonly installed: string[] } {
  const installed: string[] = [];
  return {
    installed,
    source: new PrivateSkillSource({
      sourceDir,
      strict,
      trustedPublicKeys: trusted,
      install: (request) => {
        installed.push(request.manifest.name);
        return Promise.resolve();
      },
    }),
  };
}

/**
 * 从 `.ohb` 字节流里解出 `bundle.json` 清单（store 无压缩；判据自己解一遍以保持**独立**）。
 * @param zip 包字节
 * @returns 清单
 */
function manifestOf(zip: Buffer): BundleManifest {
  let offset = 0;
  while (offset + 30 <= zip.length) {
    const compressedSize = zip.readUInt32LE(offset + 18);
    const nameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = zip.subarray(nameStart, nameStart + nameLength).toString('utf8');
    const dataStart = nameStart + nameLength + extraLength;
    if (name === 'bundle.json') {
      return JSON.parse(
        zip.subarray(dataStart, dataStart + compressedSize).toString('utf8'),
      ) as BundleManifest;
    }
    offset = dataStart + compressedSize;
  }
  throw new Error('包内没有 bundle.json');
}

test('G2 判据①（原文红线）：无签名包在**严格档被拒**，且不进入安装路径', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'g2-'));
  const sourceDir = join(dir, 'source');
  place(sourceDir, await makeBundle(dir, 'unsigned'), 'unsigned.ohb');
  const { source, installed } = makeSource(sourceDir, true, [PUBLISHER.publicKeySsh()]);

  const entries = source.list();
  assert.strictEqual(entries.length, 1);
  const entry = entries[0];
  assert.ok(entry !== undefined);
  assert.strictEqual(entry.accepted, false, '无签名包在严格档必须被拒');
  assert.strictEqual(entry.tier, 'community');
  assert.match(String(entry.reason), /严格档要求 Ed25519 签名/);
  assert.strictEqual(entry.signatureKind, 'none');

  const report = await source.sync();
  assert.deepStrictEqual(report.installed, [], '被拒的包不得进入安装路径');
  assert.deepStrictEqual(report.refused, ['unsigned']);
  assert.deepStrictEqual(installed, [], '安装回调零调用');
});

test('G2 判据②：仅 HMAC 签名同样不算凭据（严格档拒，原因说明对称性的问题）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'g2-hmac-'));
  const sourceDir = join(dir, 'source');
  place(sourceDir, await makeBundle(dir, 'hmaconly', { hmac: true }), 'hmaconly.ohb');
  const { source } = makeSource(sourceDir, true, [PUBLISHER.publicKeySsh()]);
  const entry = source.list()[0];
  assert.ok(entry !== undefined);
  assert.strictEqual(entry.signatureKind, 'hmac', '夹具必须真的带 HMAC 签名');
  assert.strictEqual(entry.accepted, false);
  assert.match(String(entry.reason), /HMAC 是对称的/);
});

test('G2 判据③④：信任根外签名拒 / 内容被篡改拒（两类原因可区分）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'g2-sign-'));
  const sourceDir = join(dir, 'source');

  // ③ 有效签名但发布者不在信任根：包由 PUBLISHER 签，信任根里**只有** STRANGER 的公钥。
  place(sourceDir, await makeBundle(dir, 'stranger', { ed25519: PUBLISHER }), 'stranger.ohb');
  const strangerSource = makeSource(sourceDir, true, [STRANGER.publicKeySsh()]).source;
  const strangerEntry = strangerSource.list()[0];
  assert.ok(strangerEntry !== undefined);
  assert.strictEqual(strangerEntry.accepted, false);
  assert.match(String(strangerEntry.reason), /不在信任根内/);

  // 正对照：同一包放进"信任 PUBLISHER"的源 ⇒ 接收且档位 verified。
  const trustedSource = makeSource(sourceDir, true, [PUBLISHER.publicKeySsh()]).source;
  const trustedEntry = trustedSource.list()[0];
  assert.ok(trustedEntry !== undefined);
  assert.strictEqual(trustedEntry.accepted, true, '信任根内 + 验签通过 ⇒ 必须接收');
  assert.strictEqual(trustedEntry.tier, 'verified');
  assert.strictEqual(trustedEntry.signatureKind, 'ed25519');

  // ④ 篡改：解出包内清单改版本号再放回 ⇒ 验签失败（正文被改）。
  const tamperedDir = join(dir, 'tampered');
  mkdirSync(tamperedDir, { recursive: true });
  const original = await makeBundle(dir, 'tamperme', { ed25519: PUBLISHER });
  const bytes = readFileSync(original);
  const text = bytes.toString('latin1').replace('0.1.0', '9.9.9');
  const tamperedPath = join(tamperedDir, 'tamperme.ohb');
  writeFileSync(tamperedPath, Buffer.from(text, 'latin1'));
  const tamperedSource = makeSource(tamperedDir, true, [PUBLISHER.publicKeySsh()]).source;
  const tamperedEntry = tamperedSource.list()[0];
  assert.ok(tamperedEntry !== undefined);
  assert.strictEqual(tamperedEntry.accepted, false, '篡改清单必须被拒');
  assert.match(String(tamperedEntry.reason), /验签未通过/);
});

test('G2 判据⑤：宽松档接收无签名包但**如实标注 community**（绝不静默提档）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'g2-loose-'));
  const sourceDir = join(dir, 'source');
  place(sourceDir, await makeBundle(dir, 'unsigned'), 'unsigned.ohb');
  const { source, installed } = makeSource(sourceDir, false, [PUBLISHER.publicKeySsh()]);
  const entry = source.list()[0];
  assert.ok(entry !== undefined);
  assert.strictEqual(entry.accepted, true, '宽松档应接收');
  assert.strictEqual(entry.tier, 'community', '无签名包**永远不是** verified');
  assert.strictEqual(entry.reason, undefined);

  const report = await source.sync();
  assert.deepStrictEqual(report.installed, ['unsigned']);
  assert.deepStrictEqual(installed, ['unsigned']);
});

test('G2 判据⑥：混合源只装放行集；空信任根在严格档下一切皆拒（fail-closed）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'g2-mixed-'));
  const sourceDir = join(dir, 'source');
  place(sourceDir, await makeBundle(dir, 'signed', { ed25519: PUBLISHER }), 'a-signed.ohb');
  place(sourceDir, await makeBundle(dir, 'plain'), 'b-plain.ohb');
  const { source, installed } = makeSource(sourceDir, true, [PUBLISHER.publicKeySsh()]);
  const report = await source.sync();
  assert.deepStrictEqual(report.installed, ['signed'], '只装放行集');
  assert.deepStrictEqual(report.refused, ['plain']);
  assert.deepStrictEqual(installed, ['signed'], '安装回调只被放行集调用一次');
  // 确定性：逐包裁决按文件名升序。
  assert.deepStrictEqual(
    source.list().map((e) => e.file),
    ['a-signed.ohb', 'b-plain.ohb'],
  );

  // 空信任根：连合法签名也不认（"信任根为空"必须是全拒，不是"默认信任任何签名"）。
  const emptyTrust = makeSource(sourceDir, true, []).source;
  assert.deepStrictEqual(
    emptyTrust.list().map((e) => e.accepted),
    [false, false],
    '空信任根 ⇒ 严格档下一切皆拒',
  );
});

test('G2 打包侧：identity 写入公钥与签名，且签名**不覆盖自身**（可独立复核）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'g2-pack-'));
  const path = await makeBundle(dir, 'signed-pack', { ed25519: PUBLISHER });
  const manifest = manifestOf(readFileSync(path));
  assert.strictEqual(manifest.publisherPublicKey, PUBLISHER.publicKeySsh(), '清单必须带发布者公钥');
  assert.ok((manifest.signatureEd25519 ?? '').length > 0, '清单必须带 Ed25519 签名');

  // ① 独立复核：用公开的规范化口径 + 公钥自己验一遍（证明验签不是黑箱）。
  const canonical = PluginBundler.canonicalManifestOf(manifest);
  assert.strictEqual(
    Ed25519PublicKey.verify(canonical, manifest.signatureEd25519 ?? '', PUBLISHER.publicKeySsh()),
    true,
    '按公开口径重算必须验签通过',
  );
  // ② 签名不覆盖自身：**只改签名字段**不得改变被签内容（否则打包端与验签端必然对不上）。
  assert.strictEqual(
    PluginBundler.canonicalManifestOf({ ...manifest, signatureEd25519: 'x', signature: 'y' }),
    canonical,
  );
  // ③ 改正文则被签内容必须变（否则篡改检测形同虚设）。
  assert.notStrictEqual(
    PluginBundler.canonicalManifestOf({ ...manifest, version: '9.9.9' }),
    canonical,
  );
});

test('G2 源目录不存在 ⇒ 空源（不是错误、不抛）', () => {
  const source = new PrivateSkillSource({
    sourceDir: join(mkdtempSync(join(tmpdir(), 'g2-none-')), 'nope'),
    strict: true,
    trustedPublicKeys: [],
    install: () => Promise.resolve(),
  });
  assert.deepStrictEqual(source.list(), []);
});

test('G2 包内缺清单 / 非 zip ⇒ 拒且原因可读（不是"读不出就当空的"）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'g2-bad-'));
  writeFileSync(join(dir, 'broken.ohb'), Buffer.from('not a zip at all'), 'utf8');
  const source = new PrivateSkillSource({
    sourceDir: dir,
    strict: false,
    trustedPublicKeys: [],
    install: () => Promise.resolve(),
  });
  const entry = source.list()[0];
  assert.ok(entry !== undefined);
  assert.strictEqual(entry.accepted, false);
  assert.match(String(entry.reason), /缺 bundle\.json|无法读取包清单/);
});
