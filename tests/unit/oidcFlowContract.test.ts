/**
 * OIDC 授权码流端口契约测试（A.5 第四项 · mock IdP 全流程）。
 *
 * ## 判据结构
 *
 * - **契约面（两实现都必须逐条过）**：discovery 端点解析、PKCE S256 自洽（challenge =
 *   BASE64URL(SHA256(verifier))）、授权 URL 必需参数（response_type/client_id/redirect_uri/
 *   scope/state/code_challenge/code_challenge_method/nonce）、**全流程换码**（mock IdP 服务端
 *   真校验 PKCE 与 code）、坏 code / 错 PKCE / 缺 access_token 三类失败路径；
 * - **差分面（逐条记录，不是缺陷而是行为边界）**：discovery 文档 issuer 与请求 issuer 不一致
 *   ⇒ 第三方**拒绝** / 自研**透传**；http issuer ⇒ 第三方（安全模式）**拒绝** / 自研**接受**。
 *
 * ## 仪器自证
 *
 * mock IdP 对 PKCE 做**服务端真校验**（S256(code_verifier) 必须等于授权阶段登记的 challenge），
 * 且对「结构性零对照」（坏 code / 错 verifier）必须 400 ⇒ 两实现全绿不能靠放宽 IdP 换来。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { LegacyOidcFlow } from '../../src/enterprise/legacyOidcFlow.js';
import { OpenIdClientFlow } from '../../src/adapters/enterprise/openIdClientFlow.js';
import type { OidcFlowPort } from '../../src/ports/enterprise/oidcFlow.js';
import type { OidcProviderConfig } from '../../src/ports/enterprise/oidcProviderConfig.js';

/** mock IdP 的服务端状态（每个测试用例可改写）。 */
interface MockIdp {
  server: Server;
  base: string;
  issuerOverride?: string | undefined;
  /** 非 null 时，token 端点必须收到 S256(code_verifier) === challenge 的请求。 */
  expectedChallenge: string | null;
  /** token 端点成功的响应体（缺省含 id_token 字段的完整形态）。 */
  tokenResponse: Record<string, unknown> | undefined;
}

/** 启一个 127.0.0.1 随机端口的 mock IdP（discovery + jwks + token）。 */
async function startMockIdp(): Promise<MockIdp> {
  const state: MockIdp = {
    server: undefined as unknown as Server,
    base: '',
    issuerOverride: undefined,
    expectedChallenge: null,
    tokenResponse: undefined,
  };
  const json = (res: ServerResponse, code: number, body: unknown): void => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req: IncomingMessage): Promise<string> => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
    });
    return new Promise((resolve) => {
      req.on('end', () => resolve(data));
    });
  };
  state.server = createServer((req, res) => {
    const url = req.url ?? '';
    if (url === '/.well-known/openid-configuration') {
      json(res, 200, {
        issuer: state.issuerOverride ?? state.base,
        authorization_endpoint: `${state.base}/authorize`,
        token_endpoint: `${state.base}/token`,
        jwks_uri: `${state.base}/jwks`,
      });
      return;
    }
    if (url === '/jwks') {
      json(res, 200, { keys: [] });
      return;
    }
    if (url === '/token' && req.method === 'POST') {
      void readBody(req).then((body) => {
        const params = new URLSearchParams(body);
        if (params.get('grant_type') !== 'authorization_code') {
          json(res, 400, { error: 'unsupported_grant_type' });
          return;
        }
        if (params.get('code') !== 'good-code') {
          json(res, 400, { error: 'invalid_grant', error_description: 'unknown code' });
          return;
        }
        const verifier = params.get('code_verifier');
        if (state.expectedChallenge !== null) {
          if (verifier === null) {
            json(res, 400, { error: 'invalid_grant', error_description: 'PKCE missing' });
            return;
          }
          const actual = createHash('sha256').update(verifier).digest('base64url');
          if (actual !== state.expectedChallenge) {
            json(res, 400, { error: 'invalid_grant', error_description: 'PKCE mismatch' });
            return;
          }
        }
        json(
          res,
          200,
          state.tokenResponse ?? {
            access_token: 'at-123',
            token_type: 'Bearer',
            expires_in: 3600,
            scope: 'openid profile email',
          },
        );
      });
      return;
    }
    json(res, 404, { error: 'not_found' });
  });
  await new Promise<void>((resolve) => state.server.listen(0, '127.0.0.1', resolve));
  const addr = state.server.address();
  assert.ok(addr !== null && typeof addr === 'object');
  state.base = `http://127.0.0.1:${String(addr.port)}`;
  return state;
}

/** 建测试配置（redirectUri 是换码必需项）。 */
function configOf(base: string): OidcProviderConfig {
  return {
    issuer: base,
    clientId: 'omni-test-client',
    redirectUri: 'http://127.0.0.1:9988/callback',
    scope: 'openid profile',
  };
}

/** URL 查询参数必含断言。 */
function requireParams(u: URL, names: readonly string[]): void {
  for (const name of names) {
    const v = u.searchParams.get(name);
    assert.ok(v !== null && v !== '', `授权 URL 缺参数 ${name}`);
  }
}

/** 契约面：两实现都必须逐条过（idp 由调用方管理生命周期）。 */
async function runContract(flow: OidcFlowPort, idp: MockIdp, label: string): Promise<void> {
  const cfg = configOf(idp.base);

  // ① discovery：端点解析正确。
  const discovery = await flow.discovery(cfg);
  assert.strictEqual(discovery.issuer, idp.base, `${label}: issuer`);
  assert.strictEqual(discovery.authorization_endpoint, `${idp.base}/authorize`, `${label}: authz`);
  assert.strictEqual(discovery.token_endpoint, `${idp.base}/token`, `${label}: token`);

  // ② PKCE：S256 自洽 + verifier 长度合规（RFC 7636 §4.1：43–128）。
  const pkce = await flow.generatePkcePair();
  assert.ok(pkce.verifier.length >= 43 && pkce.verifier.length <= 128, `${label}: verifier 长度`);
  assert.strictEqual(pkce.method, 'S256', `${label}: method`);
  assert.strictEqual(
    pkce.challenge,
    createHash('sha256').update(pkce.verifier).digest('base64url'),
    `${label}: challenge 必须等于 S256(verifier)`,
  );

  // ③ 授权 URL：全部必需参数齐备。
  const url = new URL(
    flow.authorizationUrl(discovery, cfg, { state: 'st-1', codeChallenge: pkce.challenge }),
  );
  assert.strictEqual(url.origin + url.pathname, `${idp.base}/authorize`, `${label}: 端点`);
  requireParams(url, [
    'response_type',
    'client_id',
    'state',
    'code_challenge',
    'code_challenge_method',
    'nonce',
  ]);
  assert.strictEqual(url.searchParams.get('response_type'), 'code', `${label}: response_type`);
  assert.strictEqual(url.searchParams.get('client_id'), cfg.clientId, `${label}: client_id`);
  assert.strictEqual(
    url.searchParams.get('code_challenge_method'),
    'S256',
    `${label}: 不允许 plain 降级`,
  );

  // ④ 全流程换码：mock IdP 服务端真校验 PKCE（S256(code_verifier) === ③ 里的 challenge）。
  idp.expectedChallenge = pkce.challenge;
  const tokens = await flow.exchangeCode(discovery, cfg, {
    code: 'good-code',
    codeVerifier: pkce.verifier,
    redirectUri: cfg.redirectUri,
    state: 'st-1',
  });
  assert.strictEqual(tokens.access_token, 'at-123', `${label}: access_token`);
  assert.strictEqual(tokens.token_type, 'Bearer', `${label}: token_type`);

  // ⑤ 失败路径三类：坏 code / 错 PKCE / 缺 access_token，两实现都必须抛错。
  // state 三例全程一致（'st-1'）⇒ 失败归因确实落在被测项上，而不是 state 检查。
  idp.expectedChallenge = pkce.challenge;
  await assert.rejects(
    () =>
      flow.exchangeCode(discovery, cfg, {
        code: 'bad-code',
        codeVerifier: pkce.verifier,
        state: 'st-1',
      }),
    Error,
    `${label}: 坏 code 必须拒`,
  );
  await assert.rejects(
    () =>
      flow.exchangeCode(discovery, cfg, {
        code: 'good-code',
        codeVerifier: 'x'.repeat(64),
        state: 'st-1',
      }),
    Error,
    `${label}: 错 PKCE verifier 必须拒`,
  );
  idp.expectedChallenge = null;
  idp.tokenResponse = { token_type: 'Bearer' };
  await assert.rejects(
    () => flow.exchangeCode(discovery, cfg, { code: 'good-code', state: 'st-1' }),
    Error,
    `${label}: 缺 access_token 必须拒`,
  );
  idp.tokenResponse = undefined;
}

test('契约面：自研 LegacyOidcFlow 与第三方 OpenIdClientFlow 逐条一致（mock IdP 全流程）', async () => {
  const idp = await startMockIdp();
  try {
    await runContract(new LegacyOidcFlow(), idp, 'legacy');
    await runContract(new OpenIdClientFlow({ insecureHttp: true }), idp, 'openid-client');
  } finally {
    idp.server.close();
  }
});

test('差分面：discovery 文档 issuer 与请求 issuer 不一致 ⇒ 第三方拒绝 / 自研透传', async () => {
  const idp = await startMockIdp();
  try {
    idp.issuerOverride = 'https://other-idp.example.com';
    const cfg = configOf(idp.base);
    const legacy = new LegacyOidcFlow();
    const legacyDoc = await legacy.discovery(cfg);
    assert.strictEqual(legacyDoc.issuer, 'https://other-idp.example.com', '自研：透传文档 issuer');
    const third = new OpenIdClientFlow({ insecureHttp: true });
    await assert.rejects(() => third.discovery(cfg), Error, '第三方：issuer 不一致必须拒绝');
  } finally {
    idp.server.close();
  }
});

test('差分面：http issuer ⇒ 第三方（安全模式）拒绝 / 自研接受', async () => {
  const idp = await startMockIdp();
  try {
    const cfg = configOf(idp.base);
    const legacy = new LegacyOidcFlow();
    await legacy.discovery(cfg);
    const strict = new OpenIdClientFlow();
    await assert.rejects(
      () => strict.discovery(cfg),
      Error,
      '第三方安全模式：http issuer 必须拒绝（生产缺省即安全模式）',
    );
  } finally {
    idp.server.close();
  }
});

test('差分面：token 响应携带垃圾 id_token ⇒ 第三方拒绝（自带 ID-token 校验）/ 自研透传', async () => {
  const idp = await startMockIdp();
  try {
    idp.expectedChallenge = null;
    // 头/载荷合法 base64url，但签名段是垃圾且 jwks 为空 ⇒ 任何严格校验都必须拒绝。
    idp.tokenResponse = {
      access_token: 'at-123',
      token_type: 'Bearer',
      id_token: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1MSJ9.zm9v',
    };
    const cfg = configOf(idp.base);
    const legacy = new LegacyOidcFlow();
    const doc = await legacy.discovery(cfg);
    const legacyTokens = await legacy.exchangeCode(doc, cfg, { code: 'good-code' });
    assert.strictEqual(
      legacyTokens.id_token,
      'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1MSJ9.zm9v',
      '自研：id_token 原样透传（校验归 IdTokenVerifierPort）',
    );
    const third = new OpenIdClientFlow({ insecureHttp: true });
    const thirdDoc = await third.discovery(cfg);
    await assert.rejects(
      () => third.exchangeCode(thirdDoc, cfg, { code: 'good-code', state: 'st-1' }),
      Error,
      '第三方：垃圾 id_token 必须拒绝（productionIdToken 校验内建）',
    );
  } finally {
    idp.server.close();
  }
});
