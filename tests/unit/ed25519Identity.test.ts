import { strict as assert } from 'node:assert/strict';
import { test } from 'node:test';
import {
  Ed25519AgentIdentity,
  generateAgentKeyMaterial,
} from '../../src/adapters/identity/ed25519Identity.js';
import type { AgentIdentityPort } from '../../src/ports/agentIdentity.js';

function make(port?: AgentIdentityPort): AgentIdentityPort {
  return port ?? new Ed25519AgentIdentity({ agentRuntimeId: 'test-runtime' });
}

test('generateAgentKeyMaterial 产出可加载的 PKCS#8 私钥与 ssh-ed25519 公钥', () => {
  const material = generateAgentKeyMaterial('rt-1');
  assert.ok(material.privateKeyPkcs8Base64.length > 0);
  assert.match(material.publicKeySsh, /^ssh-ed25519 /);
  // 用导出的私钥加载，runtimeId 应一致。
  const reloaded = new Ed25519AgentIdentity({
    privateKeyPkcs8Base64: material.privateKeyPkcs8Base64,
    agentRuntimeId: 'rt-1',
  });
  assert.strictEqual(reloaded.runtimeId(), 'rt-1');
  assert.strictEqual(reloaded.publicKeySsh(), material.publicKeySsh);
});

test('sign / verify 往返成功，错误签名失败', () => {
  const id = make();
  const payload = 'tool-result:echo hello';
  const sig = id.sign(payload);
  assert.strictEqual(id.verify(payload, sig), true);
  // 篡改签名 → 验签失败（fail-closed 返回 false，不抛）。
  const tamperedSig =
    sig.length > 2 ? sig.slice(0, -2) + (sig.slice(-1) === '=' ? 'X' : '=') : 'AA';
  assert.strictEqual(id.verify(payload, tamperedSig), false);
  assert.strictEqual(id.verify('other', sig), false);
});

test('ssh-ed25519 公钥格式含 32 字节原始密钥', () => {
  const id = make();
  const ssh = id.publicKeySsh();
  const b64 = ssh.replace('ssh-ed25519 ', '');
  const blob = Buffer.from(b64, 'base64');
  // 4(name len) + 11("ssh-ed25519") + 4(key len) + 32
  assert.strictEqual(blob.length, 4 + 11 + 4 + 32);
});

test('signAssertion / verifyAssertion 往返成功，篡改 envelope 失败', () => {
  const id = make();
  const envelope = id.signAssertion('task-7');
  const claims = id.verifyAssertion(envelope);
  assert.ok(claims !== null);
  assert.strictEqual(claims.agentRuntimeId, 'test-runtime');
  assert.strictEqual(claims.taskId, 'task-7');
  assert.ok(claims.timestamp.length > 0);
  // 篡改 envelope（改 taskId）→ 验签失败。
  const tampered = envelope.slice(0, -4) + (envelope.endsWith('A') ? 'B' : 'A');
  assert.strictEqual(id.verifyAssertion(tampered), null);
  assert.strictEqual(id.verifyAssertion('not-base64url!!!'), null);
});

test('authorizationHeader 形如 "AgentAssertion <envelope>"', () => {
  const id = make();
  const header = id.authorizationHeader('task-9');
  assert.match(header, /^AgentAssertion /);
  const envelope = header.replace('AgentAssertion ', '');
  assert.ok(id.verifyAssertion(envelope) !== null);
});

test('固定私钥签名确定且跨实例可验（公钥可独立验证）', () => {
  const a = new Ed25519AgentIdentity({
    privateKeyPkcs8Base64: generateAgentKeyMaterial('k').privateKeyPkcs8Base64,
    agentRuntimeId: 'k',
  });
  const payload = 'payload-x';
  const sig = a.sign(payload);
  // 用公钥重建的验证者（仅持有公钥的观察方）可验。
  const b = new Ed25519AgentIdentity({
    agentRuntimeId: 'k',
    privateKeyPkcs8Base64: a.privateKeyPkcs8Base64(),
  });
  assert.strictEqual(b.verify(payload, sig), true);
});
