import { test } from 'vitest';
import assert from 'node:assert/strict';
import { PluginSignature } from '../../src/plugin/pluginSignature.ts';
import { PluginBundler, type BundleManifest } from '../../src/plugin/pluginBundler.ts';
import { Ed25519AgentIdentity } from '../../src/adapters/identity/ed25519AgentIdentity.ts';
import type { PluginManifest } from '../../src/plugin/manifest.ts';

function signedManifest(identity: Ed25519AgentIdentity): PluginManifest {
  // 公钥必须在**被签内容**里（与 PluginBundler 的签名顺序一致），否则验签必然失败。
  const base = {
    name: 'signed-plugin',
    version: '1.0.0',
    description: 'demo',
    permissions: [] as string[],
    publisherPublicKey: identity.publicKeySsh(),
  };
  const canonical = PluginBundler.canonicalManifestOf(base as unknown as BundleManifest);
  return {
    ...base,
    signatureEd25519: identity.sign(canonical),
  } as PluginManifest;
}

test('插件验签：无签名视为通过（是否强制由调用方决定）', () => {
  assert.deepStrictEqual(PluginSignature.verify({ name: 'plain', version: '1.0.0' }), { ok: true });
});

test('插件验签：Ed25519 有效签名通过，篡改后失败', () => {
  const identity = new Ed25519AgentIdentity({ agentRuntimeId: 'plugin-signer' });
  const manifest = signedManifest(identity);
  assert.deepStrictEqual(PluginSignature.verify(manifest), { ok: true });

  const tampered = { ...manifest, description: 'tampered' } as PluginManifest;
  const result = PluginSignature.verify(tampered);
  assert.strictEqual(result.ok, false);
  if (!result.ok) assert.match(result.reason, /篡改|校验失败/u);
});

test('插件验签：带签名但缺 publisherPublicKey ⇒ 拒绝', () => {
  const result = PluginSignature.verify({
    name: 'no-key',
    version: '1.0.0',
    signatureEd25519: 'AAAA',
  } as PluginManifest);
  assert.strictEqual(result.ok, false);
  if (!result.ok) assert.match(result.reason, /publisherPublicKey/u);
  assert.throws(
    () =>
      PluginSignature.assert({
        name: 'no-key',
        version: '1.0.0',
        signatureEd25519: 'AAAA',
      } as PluginManifest),
    /验签失败/u,
  );
});

test('插件验签：OMNI_PLUGIN_REQUIRE_SIGNATURE=1 才是强制档', () => {
  assert.strictEqual(PluginSignature.required({}), false);
  assert.strictEqual(PluginSignature.required({ OMNI_PLUGIN_REQUIRE_SIGNATURE: '1' }), true);
});
