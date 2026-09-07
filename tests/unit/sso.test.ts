import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  fetchDiscovery,
  generatePkcePair,
  buildAuthorizationUrl,
  exchangeCode,
  decodeJwt,
  verifyIdTokenClaims,
  verifyJwtSignature,
  EnterpriseAuth,
  type OidcDiscovery,
} from '../../src/enterprise/sso.js';

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** 用本地 RSA 私钥签署一段 JWT（仅测试用，构造可被 RS256 校验的真实令牌）。 */
function signToken(header: object, payload: object, privateKey: crypto.KeyObject): string {
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(payload));
  const signingInput = `${h}.${p}`;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKey);
  return `${signingInput}.${b64url(sig)}`;
}

function genRsa(): { publicKey: string; privateKey: crypto.KeyObject } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKey, privateKey: crypto.createPrivateKey(privateKey) };
}

test('generatePkcePair：challenge = SHA256(verifier) 的 base64url', () => {
  const p = generatePkcePair();
  assert.strictEqual(p.method, 'S256');
  const expected = crypto
    .createHash('sha256')
    .update(p.verifier)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  assert.strictEqual(p.challenge, expected);
  assert.ok(p.verifier.length > 0);
});

test('fetchDiscovery：解析端点；缺端点抛错', async () => {
  const okFetch = (async () =>
    new Response(
      JSON.stringify({
        issuer: 'https://idp',
        authorization_endpoint: 'https://idp/a',
        token_endpoint: 'https://idp/t',
        jwks_uri: 'https://idp/j',
      }),
      { headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch;
  const d = await fetchDiscovery('https://idp/', okFetch);
  assert.strictEqual(d.authorization_endpoint, 'https://idp/a');
  assert.strictEqual(d.jwks_uri, 'https://idp/j');

  const badFetch = (async () =>
    new Response(JSON.stringify({ issuer: 'x' }), {
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
  await assert.rejects(() => fetchDiscovery('https://idp', badFetch));
});

test('buildAuthorizationUrl：含授权码流必要参数 + PKCE + nonce', () => {
  const d: OidcDiscovery = {
    issuer: 'https://idp',
    authorization_endpoint: 'https://idp/auth',
    token_endpoint: 'https://idp/t',
  };
  const url = buildAuthorizationUrl(
    d,
    { issuer: 'https://idp', clientId: 'cli', redirectUri: 'https://app/cb' },
    { state: 's1', codeChallenge: 'cc' },
  );
  const u = new URL(url);
  assert.strictEqual(u.searchParams.get('response_type'), 'code');
  assert.strictEqual(u.searchParams.get('client_id'), 'cli');
  assert.strictEqual(u.searchParams.get('redirect_uri'), 'https://app/cb');
  assert.strictEqual(u.searchParams.get('code_challenge'), 'cc');
  assert.strictEqual(u.searchParams.get('code_challenge_method'), 'S256');
  assert.strictEqual(u.searchParams.get('state'), 's1');
  assert.ok(u.searchParams.get('nonce'));
});

test('exchangeCode：POST 正确表单并解析 token 集', async () => {
  let captured: URLSearchParams | undefined;
  const mockFetch = (async (_url: string, init?: { body?: string }) => {
    captured = new URLSearchParams(init?.body ?? '');
    return new Response(
      JSON.stringify({
        access_token: 'at',
        id_token: 'it',
        token_type: 'Bearer',
        expires_in: 3600,
      }),
      {
        headers: { 'content-type': 'application/json' },
      },
    );
  }) as unknown as typeof fetch;
  const d: OidcDiscovery = {
    issuer: 'https://idp',
    authorization_endpoint: 'https://idp/a',
    token_endpoint: 'https://idp/t',
  };
  const ts = await exchangeCode(
    d,
    { issuer: 'https://idp', clientId: 'cli', clientSecret: 'sec', redirectUri: 'https://app/cb' },
    { code: 'c', codeVerifier: 'cv', fetchImpl: mockFetch },
  );
  assert.strictEqual(ts.access_token, 'at');
  assert.strictEqual(ts.token_type, 'Bearer');
  assert.strictEqual(captured?.get('grant_type'), 'authorization_code');
  assert.strictEqual(captured?.get('code_verifier'), 'cv');
  assert.strictEqual(captured?.get('client_secret'), 'sec');
});

test('decodeJwt：三段解码（不校验签名）', () => {
  const header = b64url(JSON.stringify({ alg: 'RS256' }));
  const payload = b64url(JSON.stringify({ iss: 'x', sub: 'u' }));
  const token = `${header}.${payload}.sig`;
  const parts = decodeJwt(token);
  assert.strictEqual(parts.header['alg'], 'RS256');
  assert.strictEqual(parts.payload['sub'], 'u');
  assert.strictEqual(parts.signature, 'sig');
});

test('verifyIdTokenClaims：匹配通过；aud 不匹配 / 过期抛错', () => {
  const base = {
    iss: 'https://idp',
    aud: 'cli',
    sub: 'u1',
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  assert.doesNotThrow(() => verifyIdTokenClaims(base, { issuer: 'https://idp', clientId: 'cli' }));
  assert.throws(() =>
    verifyIdTokenClaims({ ...base, aud: 'other' }, { issuer: 'https://idp', clientId: 'cli' }),
  );
  assert.throws(() =>
    verifyIdTokenClaims({ ...base, exp: 1 }, { issuer: 'https://idp', clientId: 'cli' }),
  );
});

test('verifyJwtSignature：正确 RS256 令牌通过；篡改抛错', () => {
  const { publicKey, privateKey } = genRsa();
  const pubJwk = crypto.createPublicKey(publicKey).export({ format: 'jwk' }) as {
    kty: string;
    n: string;
    e: string;
  };
  const jwks = { keys: [{ kty: 'RSA', n: pubJwk.n, e: pubJwk.e, kid: '1' }] };
  const token = signToken(
    { alg: 'RS256', kid: '1' },
    { iss: 'https://idp', aud: 'cli', exp: Math.floor(Date.now() / 1000) + 3600, sub: 'u1' },
    privateKey,
  );
  assert.doesNotThrow(() => verifyJwtSignature(token, jwks));
  const [h, p] = token.split('.');
  assert.throws(() => verifyJwtSignature(`${h}.${p}.abc`, jwks));
});

test('EnterpriseAuth.authenticate：有效 Bearer 返回主体；非法返回 null（fail-closed）', async () => {
  const { publicKey, privateKey } = genRsa();
  const pubJwk = crypto.createPublicKey(publicKey).export({ format: 'jwk' }) as {
    kty: string;
    n: string;
    e: string;
  };
  const discovery: OidcDiscovery = {
    issuer: 'https://idp',
    authorization_endpoint: 'https://idp/auth',
    token_endpoint: 'https://idp/t',
    jwks_uri: 'https://idp/jwks',
  };
  const mockFetch = (async (url: string) => {
    if (url === 'https://idp/jwks') {
      return new Response(
        JSON.stringify({ keys: [{ kty: 'RSA', n: pubJwk.n, e: pubJwk.e, kid: '1' }] }),
        {
          headers: { 'content-type': 'application/json' },
        },
      );
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  const auth = new EnterpriseAuth({ issuer: 'https://idp', clientId: 'cli' }, discovery, mockFetch);
  const token = signToken(
    { alg: 'RS256', kid: '1' },
    { iss: 'https://idp', aud: 'cli', exp: Math.floor(Date.now() / 1000) + 3600, sub: 'u1' },
    privateKey,
  );
  const ok = await auth.authenticate('Bearer ' + token);
  assert.ok(ok);
  assert.strictEqual(ok?.sub, 'u1');
  assert.strictEqual(await auth.authenticate('Bearer garbage'), null);
  assert.strictEqual(await auth.authenticate(undefined), null);
});
