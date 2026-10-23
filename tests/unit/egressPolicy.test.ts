/**
 * 出站 egress 策略判据：默认拒绝内网/元数据，允许清单/端口，URL 内嵌凭据拒绝。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { EgressPolicy } from '../../src/security/egressPolicy.ts';

test('默认拒绝元数据/本机，放行公网', () => {
  assert.strictEqual(
    EgressPolicy.check('https://169.254.169.254/latest', { env: {} }).blocked,
    true,
  );
  assert.strictEqual(EgressPolicy.check('http://127.0.0.1:8080', { env: {} }).blocked, true);
  assert.strictEqual(EgressPolicy.check('http://localhost.:8080', { env: {} }).blocked, true);
  assert.strictEqual(
    EgressPolicy.check('http://metadata.google.internal./x', { env: {} }).blocked,
    true,
  );
  assert.strictEqual(EgressPolicy.check('https://example.com/a', { env: {} }).blocked, false);
});

test('DNS：解析到私网/元数据即拒绝（fail-closed）', async () => {
  const privateVerdict = await EgressPolicy.checkAsync('https://private.example/x', {
    env: {},
    lookup: async () => ['10.0.0.5'],
  });
  assert.strictEqual(privateVerdict.blocked, true);
  const publicVerdict = await EgressPolicy.checkAsync('https://public.example/x', {
    env: {},
    lookup: async () => ['93.184.216.34'],
  });
  assert.strictEqual(publicVerdict.blocked, false);
});

test('显式 allowPrivate 才放行私有网段', () => {
  assert.strictEqual(
    EgressPolicy.check('http://127.0.0.1:8080', { env: { OMNI_EGRESS_ALLOW_PRIVATE: '1' } })
      .blocked,
    false,
  );
});

test('主机/端口允许清单与凭据拒绝', () => {
  assert.strictEqual(
    EgressPolicy.check('https://api.example.com/x', {
      env: { OMNI_EGRESS_ALLOW_HOSTS: '.example.com' },
    }).blocked,
    false,
  );
  assert.strictEqual(
    EgressPolicy.check('https://other.com/x', {
      env: { OMNI_EGRESS_ALLOW_HOSTS: '.example.com' },
    }).blocked,
    true,
  );
  assert.strictEqual(
    EgressPolicy.check('https://example.com/x', {
      env: { OMNI_EGRESS_ALLOW_PORTS: '443' },
    }).blocked,
    false,
  );
  assert.strictEqual(
    EgressPolicy.check('https://example.com:8443/x', {
      env: { OMNI_EGRESS_ALLOW_PORTS: '443' },
    }).blocked,
    true,
  );
  assert.strictEqual(
    EgressPolicy.check('https://user:pass@example.com/x', { env: {} }).blocked,
    true,
  );
});
