/**
 * Wave D1（ADR-0011 · EVOLVIX_SPEC §8 J9 的编解码面）：资产包签名/验签与容器判据。
 *
 * J9 三类全拒在**编解码层**的落点：
 * 1. **无签名** ⇒ `{ok:false, reason:'unsigned'}`；
 * 2. **坏签名**（用别人的私钥签、或签名字段被替换）⇒ `bad-signature`；
 * 3. **验签后篡改**（改清单正文任何一位，签名不变）⇒ `bad-signature`。
 *
 * 另钉两条容器纪律：缺清单即报错（不把插件包/空 zip 当资产包），
 * 以及**发布者公钥**验签（不是验签方自己的私钥）——用「另一个身份」验签必须失败。
 *
 * 变异自证：让 `verify` 恒返回 ok ⇒ 第 2、3 类立刻红；把规范化改成 `JSON.stringify(manifest)`（含签名）
 * ⇒ 签/验双方算不出同一正文，第 1 类「正常包可验签通过」也会红。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AssetPackCodec } from '../../src/asset/assetPackCodec.js';
import { Ed25519AgentIdentity } from '../../src/adapters/identity/ed25519AgentIdentity.js';
import { Zip } from '../../src/plugin/zip.js';
import type { AssetPackManifest } from '../../src/ports/asset.js';

/**
 * 造一份未签名清单。
 * @param identity 发布者身份
 * @param name 包名
 * @returns 清单
 */
function manifestOf(identity: Ed25519AgentIdentity, name = 'pack-a'): AssetPackManifest {
  return {
    format: 'omniharness-asset-pack',
    version: 1,
    name,
    publisher: { runtimeId: identity.runtimeId(), publicKeySsh: identity.publicKeySsh() },
    issuedAt: '2026-10-04T00:00:00.000Z',
    assets: [
      {
        schemaKind: 'skill',
        name: `${name}-skill`,
        asset: { name: `${name}-skill`, description: 'd', instructions: 'i' },
        parents: ['x', 'y'],
        operator: 'twist:x+y',
      },
    ],
  };
}

test('D1 正常路径：签名的清单可被第三方用发布者公钥验签通过（非对称）', () => {
  const publisher = new Ed25519AgentIdentity({ agentRuntimeId: 'pub-1' });
  const signed = AssetPackCodec.sign(manifestOf(publisher), publisher);
  assert.strictEqual(typeof signed.signature, 'string');
  const verdict = AssetPackCodec.verify(signed);
  assert.strictEqual(verdict.ok, true);
  if (verdict.ok) {
    assert.strictEqual(verdict.signed, true);
    assert.strictEqual(verdict.publisher.runtimeId, 'pub-1');
  }
});

test('D1 J9-① 无签名即拒（严格档的第一道闸）', () => {
  const publisher = new Ed25519AgentIdentity({ agentRuntimeId: 'pub-1' });
  const verdict = AssetPackCodec.verify(manifestOf(publisher));
  assert.deepStrictEqual(verdict, { ok: false, reason: 'unsigned' });
});

test('D1 J9-② 坏签名即拒（换人签 / 签名被替换）', () => {
  const publisher = new Ed25519AgentIdentity({ agentRuntimeId: 'pub-1' });
  const impostor = new Ed25519AgentIdentity({ agentRuntimeId: 'pub-2' });
  const signed = AssetPackCodec.sign(manifestOf(publisher), publisher);

  // 用冒充者的私钥重签，但保留发布者公钥 ⇒ 验签必须失败。
  const forged = { ...signed, signature: impostor.sign(AssetPackCodec.canonicalPayload(signed)) };
  assert.strictEqual(AssetPackCodec.verify(forged).ok, false);
  assert.strictEqual((AssetPackCodec.verify(forged) as { reason: string }).reason, 'bad-signature');

  // 直接替换签名字段。
  const tamperedSig = { ...signed, signature: Buffer.from('not-a-signature').toString('base64') };
  assert.strictEqual(AssetPackCodec.verify(tamperedSig).ok, false);
});

test('D1 J9-③ 验签后篡改即拒（正文任意一位被改）', () => {
  const publisher = new Ed25519AgentIdentity({ agentRuntimeId: 'pub-1' });
  const signed = AssetPackCodec.sign(manifestOf(publisher), publisher);

  const tamperedAsset = {
    ...signed,
    assets: [
      {
        ...signed.assets[0]!,
        asset: { name: 'pack-a-skill', description: 'd', instructions: '已被替换的指令' },
      },
    ],
  };
  assert.strictEqual(AssetPackCodec.verify(tamperedAsset).ok, false, '改资产正文必须被抓到');

  const tamperedPublisher = {
    ...signed,
    publisher: { ...signed.publisher, runtimeId: 'pub-evil' },
  };
  assert.strictEqual(AssetPackCodec.verify(tamperedPublisher).ok, false, '改发布者字段必须被抓到');

  const tamperedOrder = { ...signed, issuedAt: '2026-10-05T00:00:00.000Z' };
  assert.strictEqual(AssetPackCodec.verify(tamperedOrder).ok, false, '改签发时间必须被抓到');

  const tamperedName = { ...signed, name: 'pack-b' };
  assert.strictEqual(AssetPackCodec.verify(tamperedName).ok, false, '改包名必须被抓到');
});

test('D1 公钥格式：非 ssh-ed25519 / 结构非法一律拒（不静默跳过验签）', () => {
  const publisher = new Ed25519AgentIdentity({ agentRuntimeId: 'pub-1' });
  const signed = AssetPackCodec.sign(manifestOf(publisher), publisher);
  const badFormat = {
    ...signed,
    publisher: { ...signed.publisher, publicKeySsh: 'ssh-rsa AAAAB3NzaC1yc2E=' },
  };
  const verdict = AssetPackCodec.verify(badFormat);
  assert.strictEqual(verdict.ok, false);
  assert.match((verdict as { reason: string }).reason, /只支持 ssh-ed25519/);

  const truncated = {
    ...signed,
    publisher: { ...signed.publisher, publicKeySsh: 'ssh-ed25519 AA==' },
  };
  const truncVerdict = AssetPackCodec.verify(truncated);
  assert.strictEqual(truncVerdict.ok, false);
  assert.match((truncVerdict as { reason: string }).reason, /公钥|base64/);
});

test('D1 容器：签名的包经 zip 往返后仍可验签；缺清单/误读插件包显式报错', () => {
  const publisher = new Ed25519AgentIdentity({ agentRuntimeId: 'pub-1' });
  const signed = AssetPackCodec.sign(manifestOf(publisher), publisher);
  const bytes = AssetPackCodec.encode(signed);
  const decoded = AssetPackCodec.decode(bytes);
  assert.deepStrictEqual(decoded, signed, '往返必须逐字段一致');
  assert.strictEqual(AssetPackCodec.verify(decoded).ok, true);

  // 缺清单（空 zip）：不得当成「空包」接受。
  assert.throws(() => AssetPackCodec.decode(Zip.zipStore([])), /不是资产包：缺少 asset-pack\.json/);
  // 误把插件包喂进来：报错里点名包内条目，便于定位。
  const pluginBundle = Zip.zipStore([{ name: 'bundle.json', data: Buffer.from('{}') }]);
  assert.throws(() => AssetPackCodec.decode(pluginBundle), /包内条目：bundle\.json/);
  // 清单 JSON 非法 / format 不符。
  const broken = Zip.zipStore([{ name: 'asset-pack.json', data: Buffer.from('{not json') }]);
  assert.throws(() => AssetPackCodec.decode(broken), /清单 JSON 非法/);
  const wrongFormat = Zip.zipStore([
    { name: 'asset-pack.json', data: Buffer.from(JSON.stringify({ format: 'other', version: 1 })) },
  ]);
  assert.throws(() => AssetPackCodec.decode(wrongFormat), /format 非法/);
});
