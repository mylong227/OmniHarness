/**
 * Wave A.5（依赖准入第二项 · `jose`）：`IdTokenVerifierPort` 的判据——**含与自研实现的差分对照**。
 *
 * ## 判据分三组
 *
 * 1. **安全硬要求（必须拒）**：算法混淆（`none` / `HS256` 用公钥当密钥）、篡改 payload/签名、
 *    iss/aud/nonce 不匹配、过期与 `nbf` 未到、多受众缺 `azp`、超体积令牌、JWKS 超时。
 * 2. **能力增益（自研做不到，这里必须过）**：`ES256` 验签通过；时钟偏移容忍；
 *    **未知 kid 触发 JWKS 重取**（密钥轮换期间不误拒）。
 * 3. **差分对照（把"更安全"写成可核验的数字）**：同一批令牌喂给两个实现，逐条记录分歧——
 *    `ES256`、`azp`、时钟偏移三处自研实现拒绝/放行不同，其余一致。
 *
 * 判据自带**正对照**：同一套夹具在「合法令牌」上必须绿（否则"全拒"也能骗过安全判据）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { generateKeyPair, exportJWK, SignJWT, type JWK } from 'jose';

import { JoseIdTokenVerifier } from '../../src/adapters/enterprise/joseIdTokenVerifier.js';
import { LegacyIdTokenVerifier } from '../../src/adapters/enterprise/legacyIdTokenVerifier.js';
import { EnterpriseAuth } from '../../src/enterprise/oidcClient.js';
import type { IdTokenVerifierPort } from '../../src/ports/enterprise/idTokenVerifier.js';

/** 私钥类型：**从 jose 的 generateKeyPair 反推**（v6 起不再导出 `KeyLike`，不手抄避免漂移）。 */
type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

const ISSUER = 'https://idp.example.com';
const AUDIENCE = 'client-abc';
const NONCE = 'nonce-123';

/** 一套密钥材料。 */
interface KeyMaterial {
  /** 私钥。 */
  readonly privateKey: PrivateKey;
  /** 公钥 JWK（带 kid）。 */
  readonly jwk: JWK;
}

/**
 * 生成一对带 kid 的密钥。
 * @param alg 算法（RS256 / ES256）
 * @param kid 密钥 id
 * @returns 密钥材料
 */
async function makeKey(alg: 'RS256' | 'ES256', kid: string): Promise<KeyMaterial> {
  const { publicKey, privateKey } = await generateKeyPair(alg, { extractable: true });
  const jwk = await exportJWK(publicKey);
  return { privateKey, jwk: { ...jwk, kid, alg, use: 'sig' } };
}

/**
 * 起一个 mock IdP（只服务 JWKS；可运行时替换为轮换后的密钥集）。
 * @returns 服务器句柄、JWKS URL、替换密钥集的方法与关闭方法
 */
async function startMockIdp(initial: readonly JWK[]): Promise<{
  readonly jwksUrl: string;
  readonly setKeys: (keys: readonly JWK[]) => void;
  readonly setDelayMs: (ms: number) => void;
  readonly close: () => Promise<void>;
}> {
  let keys = [...initial];
  let delayMs = 0;
  let hits = 0;
  const server: Server = createServer((req, res) => {
    hits += 1;
    const respond = (): void => {
      if (req.url === '/jwks') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ keys }));
        return;
      }
      if (req.url === '/hits') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ hits }));
        return;
      }
      res.writeHead(404);
      res.end();
    };
    if (delayMs > 0) setTimeout(respond, delayMs);
    else respond();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    jwksUrl: `http://127.0.0.1:${String(port)}/jwks`,
    setKeys: (next) => {
      keys = [...next];
    },
    setDelayMs: (ms) => {
      delayMs = ms;
    },
    close: async () => {
      server.close();
      await once(server, 'close');
    },
  };
}

/**
 * 签一个 id_token。
 *
 * **时间声明走独立参数**（`expSec` / `nbfSec`）而不是塞进 `extra`：
 * 第一版把 `exp` 放进「声明覆盖」里，结果被随后的 `setExpirationTime(now+300)` **覆盖**，
 * 于是「已过期」用例其实签出的是合法令牌——判据表面上跑过、实际什么都没验。
 * 这种「夹具自己把被测条件抹掉」的坑正是 §11.3「变异测试先确认变异落地」要防的。
 * @param key 签名密钥
 * @param alg 算法
 * @param kid 密钥 id
 * @param opts 非时间声明（`extra`）与时间声明（`expSec` / `nbfSec`）
 * @returns JWT 字符串
 */
async function signToken(
  key: PrivateKey,
  alg: 'RS256' | 'ES256',
  kid: string,
  opts: {
    readonly extra?: Record<string, unknown> | undefined;
    readonly expSec?: number | undefined;
    readonly nbfSec?: number | undefined;
  } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = { sub: 'user-1', nonce: NONCE, ...(opts.extra ?? {}) };
  // exp 显式写入 payload 并**不做** setExpirationTime（后者会覆盖 payload 里的同名字段）。
  payload['exp'] = opts.expSec ?? now + 300;
  if (opts.nbfSec !== undefined) payload['nbf'] = opts.nbfSec;
  const jwt = new SignJWT(payload)
    .setProtectedHeader({ alg, kid })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE);
  return jwt.setIssuedAt(now).sign(key);
}

/**
 * 手工拼一个无签名（alg=none）令牌。
 * @param payload 声明
 * @returns JWT 字符串
 */
function noneToken(payload: Record<string, unknown>): string {
  const b64 = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.`;
}

test('A.5-jose 正对照：合法 RS256 / ES256 令牌均验签通过（ES256 是自研做不到的那一半）', async () => {
  const rsa = await makeKey('RS256', 'rsa-1');
  const ec = await makeKey('ES256', 'ec-1');
  const idp = await startMockIdp([rsa.jwk, ec.jwk]);
  try {
    const verifier = new JoseIdTokenVerifier();
    const rsaToken = await signToken(rsa.privateKey, 'RS256', 'rsa-1');
    const rsaResult = await verifier.verify({
      token: rsaToken,
      jwksUrl: idp.jwksUrl,
      issuer: ISSUER,
      audience: AUDIENCE,
      nonce: NONCE,
    });
    assert.strictEqual(rsaResult.ok, true, rsaResult.ok ? '' : rsaResult.reason);
    if (rsaResult.ok) {
      assert.strictEqual(rsaResult.claims['sub'], 'user-1');
      assert.strictEqual(rsaResult.algorithm, 'RS256');
    }

    const ecToken = await signToken(ec.privateKey, 'ES256', 'ec-1');
    const ecResult = await verifier.verify({
      token: ecToken,
      jwksUrl: idp.jwksUrl,
      issuer: ISSUER,
      audience: AUDIENCE,
      nonce: NONCE,
    });
    assert.strictEqual(ecResult.ok, true, ecResult.ok ? '' : ecResult.reason);
    if (ecResult.ok) assert.strictEqual(ecResult.algorithm, 'ES256');

    // 可审计面：白名单里既有 RS 也有 ES，且**不含** none / HS*。
    const allowed = verifier.allowedAlgorithms();
    assert.ok(allowed.includes('RS256') && allowed.includes('ES256'));
    assert.ok(!allowed.some((a) => a.startsWith('HS')), '白名单绝不能含 HS*（算法混淆入口）');
    assert.ok(!allowed.includes('none'), '白名单绝不能含 none');
  } finally {
    await idp.close();
  }
});

test('A.5-jose 算法混淆与伪造：none / HS256（公钥当密钥）/ 篡改一律拒', async () => {
  const rsa = await makeKey('RS256', 'rsa-1');
  const idp = await startMockIdp([rsa.jwk]);
  try {
    const verifier = new JoseIdTokenVerifier();
    const base = {
      jwksUrl: idp.jwksUrl,
      issuer: ISSUER,
      audience: AUDIENCE,
      nonce: NONCE,
    };

    // ① alg=none：无签名令牌必须拒（历史上最常见的绕过）。
    const none = noneToken({
      iss: ISSUER,
      aud: AUDIENCE,
      sub: 'attacker',
      nonce: NONCE,
      exp: 9_999_999_999,
    });
    const noneResult = await verifier.verify({ ...base, token: none });
    assert.strictEqual(noneResult.ok, false, 'alg=none 必须被拒');
    if (!noneResult.ok) assert.ok(noneResult.reason.length > 0);

    // ② 算法混淆：用 IdP 公钥当 HMAC 密钥签 HS256（若实现按 header.alg 选算法就会验签通过）。
    const publicPem = Buffer.from(JSON.stringify(rsa.jwk)).toString('utf8');
    const hsToken = await new SignJWT({ sub: 'attacker', nonce: NONCE })
      .setProtectedHeader({ alg: 'HS256', kid: 'rsa-1' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(publicPem));
    const hsResult = await verifier.verify({ ...base, token: hsToken });
    assert.strictEqual(hsResult.ok, false, 'HS256 必须被拒（白名单不含 HS*）');

    // ③ 篡改 payload（sub 被改）：签名不再匹配 ⇒ 拒。
    const good = await signToken(rsa.privateKey, 'RS256', 'rsa-1');
    const parts = good.split('.');
    const tamperedPayload = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')),
        sub: 'attacker',
      }),
      'utf8',
    ).toString('base64url');
    const tampered = `${parts[0] ?? ''}.${tamperedPayload}.${parts[2] ?? ''}`;
    const tamperedResult = await verifier.verify({ ...base, token: tampered });
    assert.strictEqual(tamperedResult.ok, false, '验签后篡改必须被拒');

    // ④ 篡改签名 ⇒ 拒。
    const badSig = `${parts[0] ?? ''}.${parts[1] ?? ''}.${'A'.repeat((parts[2] ?? '').length)}`;
    assert.strictEqual((await verifier.verify({ ...base, token: badSig })).ok, false);
  } finally {
    await idp.close();
  }
});

test('A.5-jose 声明面：iss / aud / nonce / exp / nbf / azp 逐条拒且原因可读', async () => {
  const rsa = await makeKey('RS256', 'rsa-1');
  const idp = await startMockIdp([rsa.jwk]);
  try {
    const verifier = new JoseIdTokenVerifier();
    const base = { jwksUrl: idp.jwksUrl, issuer: ISSUER, audience: AUDIENCE, nonce: NONCE };
    const now = Math.floor(Date.now() / 1000);

    // iss 不匹配：改用另一个 issuer 重签（覆盖 setIssuer）。
    const otherIss = await new SignJWT({ sub: 'u', nonce: NONCE })
      .setProtectedHeader({ alg: 'RS256', kid: 'rsa-1' })
      .setIssuer('https://evil.example.com')
      .setAudience(AUDIENCE)
      .setExpirationTime(now + 300)
      .sign(rsa.privateKey);

    const wrongAud = await new SignJWT({ sub: 'u', nonce: NONCE })
      .setProtectedHeader({ alg: 'RS256', kid: 'rsa-1' })
      .setIssuer(ISSUER)
      .setAudience('other-client')
      .setExpirationTime(now + 300)
      .sign(rsa.privateKey);
    const wrongNonce = await signToken(rsa.privateKey, 'RS256', 'rsa-1', {
      extra: { nonce: 'other-nonce' },
    });
    const expired = await signToken(rsa.privateKey, 'RS256', 'rsa-1', { expSec: now - 600 });
    const notYet = await signToken(rsa.privateKey, 'RS256', 'rsa-1', { nbfSec: now + 600 });
    const multiAudNoAzp = await new SignJWT({ sub: 'u', nonce: NONCE })
      .setProtectedHeader({ alg: 'RS256', kid: 'rsa-1' })
      .setIssuer(ISSUER)
      .setAudience([AUDIENCE, 'another-client'])
      .setExpirationTime(now + 300)
      .sign(rsa.privateKey);
    const multiAudWrongAzp = await new SignJWT({ sub: 'u', nonce: NONCE, azp: 'another-client' })
      .setProtectedHeader({ alg: 'RS256', kid: 'rsa-1' })
      .setIssuer(ISSUER)
      .setAudience([AUDIENCE, 'another-client'])
      .setExpirationTime(now + 300)
      .sign(rsa.privateKey);

    const all: readonly { readonly name: string; readonly token: string }[] = [
      { name: 'iss 不匹配', token: otherIss },
      { name: 'aud 不匹配', token: wrongAud },
      { name: 'nonce 不匹配', token: wrongNonce },
      { name: '已过期', token: expired },
      { name: 'nbf 未到', token: notYet },
      { name: '多受众缺 azp', token: multiAudNoAzp },
      { name: '多受众 azp 不匹配', token: multiAudWrongAzp },
    ];
    for (const item of all) {
      const result = await verifier.verify({ ...base, token: item.token });
      assert.strictEqual(result.ok, false, `${item.name} 必须被拒`);
      if (!result.ok) {
        assert.ok(result.reason.length > 0, `${item.name} 必须给可读原因`);
        assert.ok(!result.reason.includes(item.token), '原因里不得回显令牌本身');
      }
    }

    // 时钟偏移容忍：过期 5 秒但容忍 30 秒 ⇒ 接受；过期 600 秒 ⇒ 拒（上面已判）。
    const slightlyExpired = await signToken(rsa.privateKey, 'RS256', 'rsa-1', { expSec: now - 5 });
    const tolerated = await verifier.verify({
      ...base,
      token: slightlyExpired,
      clockToleranceSec: 30,
    });
    assert.strictEqual(
      tolerated.ok,
      true,
      'exp 超出 5 秒且容忍 30 秒 ⇒ 必须接受（否则 IdP 轻微漂移即误拒）',
    );
    const strict = await verifier.verify({ ...base, token: slightlyExpired, clockToleranceSec: 0 });
    assert.strictEqual(strict.ok, false, '容忍 0 秒 ⇒ 同一令牌必须被拒（证明容忍度真的生效）');
  } finally {
    await idp.close();
  }
});

test('A.5-jose 密钥轮换：未知 kid 触发 JWKS 重取（轮换窗口内不误拒）', async () => {
  const oldKey = await makeKey('RS256', 'old-1');
  const newKey = await makeKey('RS256', 'new-1');
  const idp = await startMockIdp([oldKey.jwk]);
  try {
    // 冷却设为 0：让「未知 kid ⇒ 立刻重取」这条行为可判（生产缺省 30s 抑制高频重取）。
    const verifier = new JoseIdTokenVerifier({ jwksCooldownMs: 0 });
    const before = await verifier.verify({
      token: await signToken(oldKey.privateKey, 'RS256', 'old-1'),
      jwksUrl: idp.jwksUrl,
      issuer: ISSUER,
      audience: AUDIENCE,
      nonce: NONCE,
    });
    assert.strictEqual(before.ok, true);

    // 轮换：IdP 开始发布新 key；此时用新 key 签的令牌应当**重取 JWKS 后通过**（而不是被误拒）。
    idp.setKeys([newKey.jwk]);
    const afterRotation = await verifier.verify({
      token: await signToken(newKey.privateKey, 'RS256', 'new-1'),
      jwksUrl: idp.jwksUrl,
      issuer: ISSUER,
      audience: AUDIENCE,
      nonce: NONCE,
    });
    assert.strictEqual(
      afterRotation.ok,
      true,
      afterRotation.ok ? '' : `轮换后不得误拒：${afterRotation.reason}`,
    );
  } finally {
    await idp.close();
  }
});

test('A.5-jose 取值有界：超体积令牌与 JWKS 超时都拒（认证路径不得悬挂）', async () => {
  const rsa = await makeKey('RS256', 'rsa-1');
  const idp = await startMockIdp([rsa.jwk]);
  try {
    const verifier = new JoseIdTokenVerifier();
    const huge = `${'a'.repeat(17 * 1024)}.${'b'.repeat(10)}.${'c'.repeat(10)}`;
    const hugeResult = await verifier.verify({
      token: huge,
      jwksUrl: idp.jwksUrl,
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    assert.strictEqual(hugeResult.ok, false);
    if (!hugeResult.ok) assert.match(hugeResult.reason, /体积上限/);

    // 非 https 且非环回 ⇒ 拒（JWKS 不得走明文外网）。
    const plain = await verifier.verify({
      token: await signToken(rsa.privateKey, 'RS256', 'rsa-1'),
      jwksUrl: 'http://idp.example.com/jwks',
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    assert.strictEqual(plain.ok, false);
    if (!plain.ok) assert.match(plain.reason, /https/);

    // JWKS 端点悬挂 ⇒ 超时拒（不挂死认证）。
    idp.setDelayMs(400);
    const timeoutResult = await verifier.verify({
      token: await signToken(rsa.privateKey, 'RS256', 'rsa-1'),
      jwksUrl: idp.jwksUrl,
      issuer: ISSUER,
      audience: AUDIENCE,
      timeoutMs: 50,
    });
    assert.strictEqual(timeoutResult.ok, false, 'JWKS 超时必须拒');
    if (!timeoutResult.ok) assert.ok(timeoutResult.reason.length > 0);
  } finally {
    await idp.close();
  }
});

test('A.5-jose 差分对照：同端口下自研实现的三处边界被逐条钉出（ES256 / azp / 时钟偏移）', async () => {
  const rsa = await makeKey('RS256', 'rsa-1');
  const ec = await makeKey('ES256', 'ec-1');
  const idp = await startMockIdp([rsa.jwk, ec.jwk]);
  try {
    const now = Math.floor(Date.now() / 1000);
    const verifiers: readonly { readonly name: string; readonly impl: IdTokenVerifierPort }[] = [
      { name: 'jose', impl: new JoseIdTokenVerifier() },
      { name: 'legacy', impl: new LegacyIdTokenVerifier() },
    ];
    const base = { jwksUrl: idp.jwksUrl, issuer: ISSUER, audience: AUDIENCE, nonce: NONCE };
    const rs256 = await signToken(rsa.privateKey, 'RS256', 'rsa-1');
    const es256 = await signToken(ec.privateKey, 'ES256', 'ec-1');
    const multiAudNoAzp = await new SignJWT({ sub: 'u', nonce: NONCE })
      .setProtectedHeader({ alg: 'RS256', kid: 'rsa-1' })
      .setIssuer(ISSUER)
      .setAudience([AUDIENCE, 'another-client'])
      .setExpirationTime(now + 300)
      .sign(rsa.privateKey);
    const slightlyExpired = await signToken(rsa.privateKey, 'RS256', 'rsa-1', { expSec: now - 5 });

    const results = new Map<string, Record<string, boolean>>();
    for (const { name, impl } of verifiers) {
      const record: Record<string, boolean> = {};
      record['RS256 合法'] = (await impl.verify({ ...base, token: rs256 })).ok;
      record['ES256 合法'] = (await impl.verify({ ...base, token: es256 })).ok;
      record['多受众缺 azp'] = (await impl.verify({ ...base, token: multiAudNoAzp })).ok;
      record['过期 5s（容忍 30s）'] = (
        await impl.verify({ ...base, token: slightlyExpired, clockToleranceSec: 30 })
      ).ok;
      results.set(name, record);
    }

    const jose = results.get('jose');
    const legacy = results.get('legacy');
    assert.ok(jose !== undefined && legacy !== undefined);
    // 一致面：RS256 合法令牌两者都必须通过（正对照——否则"全拒"也能骗过安全判据）。
    assert.strictEqual(jose['RS256 合法'], true);
    assert.strictEqual(legacy['RS256 合法'], true);
    // 分歧面（这就是"能力增益"的可核验形式）：
    assert.strictEqual(jose['ES256 合法'], true, 'jose 必须支持 ES256');
    assert.strictEqual(legacy['ES256 合法'], false, '自研实现只支持 RS256（已登记的窄面）');
    assert.strictEqual(jose['多受众缺 azp'], false, 'jose 路径必须拒多受众缺 azp');
    assert.strictEqual(legacy['多受众缺 azp'], true, '自研实现不校验 azp（已补齐的缺口）');
    assert.strictEqual(jose['过期 5s（容忍 30s）'], true, 'jose 支持时钟偏移容忍');
    assert.strictEqual(legacy['过期 5s（容忍 30s）'], false, '自研实现无容忍（时间漂移即误拒）');

    // 算法面差异同样可审计。
    assert.ok(new JoseIdTokenVerifier().allowedAlgorithms().length >= 9);
    assert.deepStrictEqual(new LegacyIdTokenVerifier().allowedAlgorithms(), ['RS256']);
  } finally {
    await idp.close();
  }
});

test('A.5 接线：EnterpriseAuth 注入校验端口后行为随之改变（不注入则走自研，逐位不变）', async () => {
  const rsa = await makeKey('RS256', 'rsa-1');
  const ec = await makeKey('ES256', 'ec-1');
  const idp = await startMockIdp([rsa.jwk, ec.jwk]);
  try {
    const discovery = {
      issuer: ISSUER,
      authorization_endpoint: '',
      token_endpoint: '',
      jwks_uri: idp.jwksUrl,
    };
    const config = { issuer: ISSUER, clientId: AUDIENCE };
    const es256 = await signToken(ec.privateKey, 'ES256', 'ec-1');
    const header = `Bearer ${es256}`;

    // 不注入：既有自研路径（只支持 RS256）⇒ ES256 令牌被拒。
    const legacyAuth = new EnterpriseAuth(config, discovery);
    assert.strictEqual(
      await legacyAuth.authenticate(header),
      null,
      '自研路径必须拒 ES256（已登记的窄面）',
    );

    // 注入：走 jose ⇒ 同一令牌通过，且返回受信任声明。
    const sdkAuth = new EnterpriseAuth(
      config,
      discovery,
      globalThis.fetch,
      new JoseIdTokenVerifier(),
    );
    const authenticated = await sdkAuth.authenticate(header);
    assert.ok(authenticated !== null, '注入后 ES256 必须通过——这是「接线真的生效」的证据');
    assert.strictEqual(authenticated.sub, 'user-1');

    // 负路径不得因接线而放宽：伪造/缺头/非 Bearer 在任何一条路径上都必须 null。
    const forged = `${es256.split('.').slice(0, 2).join('.')}.${'A'.repeat(64)}`;
    assert.strictEqual(await sdkAuth.authenticate(`Bearer ${forged}`), null, '篡改签名必须仍被拒');
    assert.strictEqual(await sdkAuth.authenticate(undefined), null, '缺头必须拒');
    assert.strictEqual(await sdkAuth.authenticate('Basic abc'), null, '非 Bearer 必须拒');
    void rsa;
  } finally {
    await idp.close();
  }
});
