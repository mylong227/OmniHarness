/**
 * `Ed25519PublicKey` 的**直接**单元判据（安全工具需要自己的判据，不能只靠调用方间接覆盖）。
 *
 * 该工具是「用**别人的**公钥验签」的唯一实现，被两处依赖：分发层（验发布者签名，ADR-0011）
 * 与 License 引擎（验授权方签名，F1）。它的失败模式是**安全失败**——把"验不了"当成"通过"
 * 会让伪造签名畅通无阻，故这里逐条钉死 fail-closed 面。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Ed25519PublicKey } from '../../src/util/ed25519PublicKey.js';
import { Ed25519AgentIdentity } from '../../src/adapters/identity/ed25519AgentIdentity.js';

test('Ed25519PublicKey：合法 ssh-ed25519 公钥可解码并验签通过（正对照）', () => {
  const signer = new Ed25519AgentIdentity({ agentRuntimeId: 'signer' });
  const payload = 'license-payload-v1';
  const signature = signer.sign(payload);
  assert.strictEqual(Ed25519PublicKey.verify(payload, signature, signer.publicKeySsh()), true);
  // 带注释的公钥（`ssh-ed25519 AAAA… comment`）同样可用——真实 authorized_keys 就是这么写的。
  assert.strictEqual(
    Ed25519PublicKey.verify(payload, signature, `${signer.publicKeySsh()} user@host`),
    true,
  );
  // 返回的是 KeyObject 而不是原因字符串。
  assert.strictEqual(typeof Ed25519PublicKey.decodeSsh(signer.publicKeySsh()), 'object');
});

test('Ed25519PublicKey：证书面 —— 换密钥/改正文/改签名三类验签失败', () => {
  const signer = new Ed25519AgentIdentity({ agentRuntimeId: 'signer' });
  const other = new Ed25519AgentIdentity({ agentRuntimeId: 'other' });
  const payload = 'x';
  const signature = signer.sign(payload);
  assert.strictEqual(
    Ed25519PublicKey.verify(payload, signature, other.publicKeySsh()),
    false,
    '用**别人的**公钥验签必须失败（否则公钥就没有约束力）',
  );
  assert.strictEqual(
    Ed25519PublicKey.verify('y', signature, signer.publicKeySsh()),
    false,
    '改正文必须失败',
  );
  assert.strictEqual(
    Ed25519PublicKey.verify(payload, Buffer.from('junk').toString('base64'), signer.publicKeySsh()),
    false,
    '改签名必须失败',
  );
});

test('Ed25519PublicKey：格式非法一律 false / 可读原因（fail-closed，绝不抛）', () => {
  const signer = new Ed25519AgentIdentity({ agentRuntimeId: 'signer' });
  const bad: readonly (readonly [string, RegExp])[] = [
    ['ssh-rsa AAAAB3NzaC1yc2E=', /只支持 ssh-ed25519/],
    ['ssh-ed25519', /只支持 ssh-ed25519/],
    ['ssh-ed25519 AA==', /公钥|base64/],
    ['', /只支持 ssh-ed25519/],
  ];
  for (const [key, pattern] of bad) {
    const decoded = Ed25519PublicKey.decodeSsh(key);
    assert.strictEqual(typeof decoded, 'string', `${key} 应返回可读原因`);
    assert.match(decoded as string, pattern);
    // 验签面：格式非法 ⇒ false，且**不抛**（安全工具不得让调用方处理异常）。
    assert.doesNotThrow(() => {
      assert.strictEqual(Ed25519PublicKey.verify('p', signer.sign('p'), key), false);
    });
  }
  // blob 结构非法（长度字段与算法名不符）：原始 32 字节套错长度前缀。
  const malformed = Buffer.concat([
    Buffer.from([0, 0, 0, 7]),
    Buffer.from('ssh-rsa'),
    Buffer.from([0, 0, 0, 32]),
    Buffer.alloc(32),
  ]).toString('base64');
  assert.match(Ed25519PublicKey.decodeSsh(`ssh-ed25519 ${malformed}`) as string, /结构非法|公钥/);
});

test('Ed25519PublicKey：接受 Buffer 与 string 两种正文（同一签名同结论）', () => {
  const signer = new Ed25519AgentIdentity({ agentRuntimeId: 'signer' });
  const text = '正文';
  const signature = signer.sign(text);
  assert.strictEqual(Ed25519PublicKey.verify(text, signature, signer.publicKeySsh()), true);
  assert.strictEqual(
    Ed25519PublicKey.verify(Buffer.from(text, 'utf8'), signature, signer.publicKeySsh()),
    true,
    'UTF-8 多字节正文在两种入参形态下必须同结论（否则调用方一换就假失败）',
  );
});
