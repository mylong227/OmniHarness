import assert from 'node:assert/strict';
import { test } from 'node:test';

import { OidcClient, type OidcProviderConfig } from '../../src/enterprise/oidcClient.js';
import { OidcFixture } from './oidcFixture.js';

/**
 * F4 更优解验证套件：用零依赖本地 IdP（`OidcFixture`，真实 HTTP + 真实 RS256）
 * 端到端验证 `EnterpriseAuth` 的 discovery → JWKS → 验签 → 声明校验全链路，
 * 完全替代「起 keycloak 容器」方案（保真度等价、效率更高、零外部依赖、跨平台一致）。
 */
test('OidcFixture: 真实 HTTP + RS256 id_token 被 EnterpriseAuth 端到端验过', async () => {
  const idp = new OidcFixture();
  await idp.start();
  try {
    const config: OidcProviderConfig = {
      issuer: idp.issuerUrl,
      clientId: 'omniharness',
      redirectUri: 'http://localhost/cb',
    };
    // 走真实 discovery fetch（HTTP）→ 真实 JWKS fetch（HTTP）→ 真实 RS256 校验。
    const auth = await OidcClient.enterpriseAuthFromIssuer(config, globalThis.fetch);
    const token = idp.issueIdToken({ sub: 'alice', clientId: 'omniharness' });
    const principal = await auth.authenticate(`Bearer ${token}`);
    assert.notStrictEqual(principal, null, '真实签名令牌竟未通过校验');
    assert.strictEqual(principal?.sub, 'alice');
  } finally {
    await idp.close();
  }
});

test('OidcFixture: 签名被篡改 → fail-closed 返回 null', async () => {
  const idp = new OidcFixture();
  await idp.start();
  try {
    const config: OidcProviderConfig = { issuer: idp.issuerUrl, clientId: 'omniharness' };
    const auth = await OidcClient.enterpriseAuthFromIssuer(config, globalThis.fetch);
    const token = idp.issueIdToken({ sub: 'bob', clientId: 'omniharness' });
    const tampered = `${token.slice(0, -2)}xx`;
    const principal = await auth.authenticate(`Bearer ${tampered}`);
    assert.strictEqual(principal, null, '签名被篡改仍放行，门禁失效');
  } finally {
    await idp.close();
  }
});

test('OidcFixture: 过期 id_token → fail-closed 返回 null', async () => {
  const idp = new OidcFixture();
  await idp.start();
  try {
    const config: OidcProviderConfig = { issuer: idp.issuerUrl, clientId: 'omniharness' };
    const auth = await OidcClient.enterpriseAuthFromIssuer(config, globalThis.fetch);
    const token = idp.issueIdToken({ sub: 'carol', clientId: 'omniharness', expiresInSec: -10 });
    const principal = await auth.authenticate(`Bearer ${token}`);
    assert.strictEqual(principal, null, '过期令牌仍放行，门禁失效');
  } finally {
    await idp.close();
  }
});

test('OidcClient.exchangeCode: 经本地 IdP /token 端点换得含真实 id_token 的令牌集', async () => {
  const idp = new OidcFixture();
  await idp.start();
  try {
    const client = new OidcClient();
    const discovery = await client.fetchDiscovery(idp.issuerUrl, globalThis.fetch);
    const tokens = await client.exchangeCode(
      discovery,
      { issuer: idp.issuerUrl, clientId: 'omniharness' },
      { code: 'authz-code', fetchImpl: globalThis.fetch },
    );
    assert.strictEqual(typeof tokens.access_token, 'string');
    assert.strictEqual(typeof tokens.id_token, 'string');
    const decoded = client.decodeJwt(tokens.id_token ?? '');
    assert.strictEqual(decoded.payload['sub'], 'user-123');
  } finally {
    await idp.close();
  }
});
