/**
 * A2A 1.0 AgentCard JWS 签名/验签判据（规范 §8.4）。
 *
 * 覆盖：签名结构（protected/signature、alg/kid/jku）、规范化后验签通过、篡改拒绝、
 * 未知 kid 拒绝、过期拒绝、无 key 不伪造签名、`fromEnv` 开关语义、服务端取卡与
 * HTTP well-known 返回同一张签名卡。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { JWK } from 'jose';
import type { RpcMessage } from '../../src/server/core/jsonRpc.ts';
import type { A2aAgentCard, A2aTransport } from '../../src/a2a/a2aProtocol.ts';
import { A2aAgentCardSigner } from '../../src/a2a/a2aAgentCardSigner.ts';
import { A2aServer } from '../../src/a2a/a2aServer.ts';
import { HttpA2aServerTransport } from '../../src/a2a/httpA2aTransport.ts';
import { Ed25519AgentIdentity } from '../../src/adapters/identity/ed25519AgentIdentity.ts';

/** 双端内存传输。 */
class MemoryTransport implements A2aTransport {
  public peer: MemoryTransport | undefined;
  public readonly received: RpcMessage[] = [];
  private callback: ((message: RpcMessage) => void) | undefined;
  public send(message: RpcMessage): void {
    this.peer?.deliver(message);
  }
  public onMessage(callback: (message: RpcMessage) => void): void {
    this.callback = callback;
  }
  public deliver(message: RpcMessage): void {
    this.received.push(message);
    this.callback?.(message);
  }
}

/** 配好一对互联的内存传输。 */
function pair(): { client: MemoryTransport; server: MemoryTransport } {
  const client = new MemoryTransport();
  const server = new MemoryTransport();
  client.peer = server;
  server.peer = client;
  return { client, server };
}

/** 生成 Ed25519 密钥对（私钥 JWK + 公钥 JWK）。 */
function makeKeys(): { privateJwk: JWK; publicJwk: JWK } {
  const pair = crypto.generateKeyPairSync('ed25519');
  return {
    privateJwk: pair.privateKey.export({ format: 'jwk' }) as JWK,
    publicJwk: pair.publicKey.export({ format: 'jwk' }) as JWK,
  };
}

/** key id。 */
const KID = 'omni-test-key-1';

/** JWKS 地址（仅用于断言 `jku` 透传）。 */
const JKU = 'https://agent.example.test/jwks.json';

/** 判据用的基础卡片。 */
const CARD: A2aAgentCard = {
  name: 'omniharness',
  description: 'test agent card',
  version: '0.2.0',
  protocolVersion: '1.0',
  url: 'http://127.0.0.1:8790/a2a',
  capabilities: { streaming: true, pushNotifications: true, extendedAgentCard: true },
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  skills: [{ id: 'echo', name: 'Echo', description: 'echo input', tags: ['echo'] }],
};

/** 只解析 KID 的 keyResolver。 */
function resolverFor(publicJwk: JWK): (kid: string) => JWK | undefined {
  return (kid) => (kid === KID ? publicJwk : undefined);
}

test('JWS ①：签名结构正确（protected 解出 alg=EdDSA/kid/jku，signature 非空）且验签通过', async () => {
  const { privateJwk, publicJwk } = makeKeys();
  const signer = new A2aAgentCardSigner({ key: { kid: KID, privateKeyJwk: privateJwk, jku: JKU } });
  const signed = await signer.sign(CARD);
  assert.strictEqual(signed.signatures?.length, 1);
  const entry = signed.signatures?.[0];
  assert.ok(entry !== undefined);
  const header = JSON.parse(Buffer.from(entry.protected, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
  assert.strictEqual(header['alg'], 'EdDSA');
  assert.strictEqual(header['typ'], 'JOSE');
  assert.strictEqual(header['kid'], KID);
  assert.strictEqual(header['jku'], JKU);
  assert.ok(entry.signature.length > 0);
  // 卡片正文被原样保留（只追加 signatures）。
  assert.deepStrictEqual({ ...signed, signatures: undefined }, { ...CARD, signatures: undefined });
  const verdict = await signer.verify(signed, resolverFor(publicJwk));
  assert.strictEqual(verdict.ok, true, verdict.reason);
  assert.strictEqual(verdict.kid, KID);
});

test('JWS ②：篡改任意字段（顶层/嵌套）都会验签失败', async () => {
  const { privateJwk, publicJwk } = makeKeys();
  const signer = new A2aAgentCardSigner({ key: { kid: KID, privateKeyJwk: privateJwk } });
  const signed = await signer.sign(CARD);
  const tamperedDescription = { ...signed, description: '已经被中间人改写' };
  const first = await signer.verify(tamperedDescription, resolverFor(publicJwk));
  assert.strictEqual(first.ok, false);
  assert.match(first.reason ?? '', /验签|载荷/u);
  const tamperedNested = {
    ...signed,
    skills: [{ id: 'echo', name: 'Echo', description: '注入的恶意描述' }],
  };
  const second = await signer.verify(tamperedNested, resolverFor(publicJwk));
  assert.strictEqual(second.ok, false);
});

test('JWS ③：未知 kid 拒绝；无签名卡片拒绝', async () => {
  const { privateJwk, publicJwk } = makeKeys();
  const signer = new A2aAgentCardSigner({ key: { kid: KID, privateKeyJwk: privateJwk } });
  const signed = await signer.sign(CARD);
  const unknown = await signer.verify(signed, () => undefined);
  assert.strictEqual(unknown.ok, false);
  assert.match(unknown.reason ?? '', /未知 kid/u);
  // 未知 kid 的验签器不能「碰巧」用别的钥匙通过。
  const wrong = makeKeys();
  const wrongKey = await signer.verify(signed, () => wrong.publicJwk);
  assert.strictEqual(wrongKey.ok, false, '错误的公钥不得通过');
  const unsigned = await signer.verify(CARD, resolverFor(publicJwk));
  assert.strictEqual(unsigned.ok, false);
  assert.match(unsigned.reason ?? '', /没有 signatures/u);
  const empty = await signer.verify({ ...CARD, signatures: [] }, resolverFor(publicJwk));
  assert.strictEqual(empty.ok, false);
});

test('JWS ④：过期签名拒绝（exp 超过时钟容忍）', async () => {
  const { privateJwk, publicJwk } = makeKeys();
  const expired = new A2aAgentCardSigner({
    key: { kid: KID, privateKeyJwk: privateJwk, expiresAt: Date.now() - 10 * 60_000 },
  });
  const signed = await expired.sign(CARD);
  const verdict = await expired.verify(signed, resolverFor(publicJwk));
  assert.strictEqual(verdict.ok, false);
  assert.match(verdict.reason ?? '', /过期/u);
  // 未过期（TTL 1 小时）时同一判据必须通过：证明拒绝来自 exp 而不是别的路径。
  const fresh = new A2aAgentCardSigner({
    key: { kid: KID, privateKeyJwk: privateJwk, expiresAt: Date.now() + 3_600_000 },
  });
  const freshSigned = await fresh.sign(CARD);
  const okVerdict = await fresh.verify(freshSigned, resolverFor(publicJwk));
  assert.strictEqual(okVerdict.ok, true, okVerdict.reason);
});

test('JWS ⑤：无 key 不伪造签名（构造抛错 / fromEnv 返回 undefined / sign 绝不产出 signatures）', async () => {
  assert.throws(() => new A2aAgentCardSigner({ key: {} }), /需要 Ed25519 私钥/u);
  assert.throws(
    () =>
      new A2aAgentCardSigner({
        // RSA 私钥不是 Ed25519：必须当场拒绝，而不是签出客户端验不过的签名。
        key: {
          privateKeyPem: crypto
            .generateKeyPairSync('rsa', { modulusLength: 2048 })
            .privateKey.export({ format: 'pem', type: 'pkcs8' }) as string,
        },
      }),
    /只接受 Ed25519/u,
  );
  assert.strictEqual(A2aAgentCardSigner.fromEnv({}), undefined);
  // 只开开关、不配 key：仍然不签（不伪造签名）。
  assert.strictEqual(A2aAgentCardSigner.fromEnv({ OMNI_A2A_SIGN_CARD: '1' }), undefined);
  assert.strictEqual(A2aAgentCardSigner.signingRequested({ OMNI_A2A_SIGN_CARD: '1' }), true);
  assert.strictEqual(A2aAgentCardSigner.signingRequested({}), false);
});

test('JWS ⑥：fromEnv 用显式 JWK 建签名器（kid/jku/TTL 生效）', async () => {
  const { privateJwk, publicJwk } = makeKeys();
  const signer = A2aAgentCardSigner.fromEnv({
    OMNI_A2A_CARD_KEY_JWK: JSON.stringify(privateJwk),
    OMNI_A2A_CARD_KID: KID,
    OMNI_A2A_CARD_JKU: JKU,
    OMNI_A2A_CARD_TTL_SEC: '3600',
  });
  assert.ok(signer !== undefined);
  const signed = await signer.sign(CARD);
  const entry = signed.signatures?.[0];
  assert.ok(entry !== undefined);
  const header = JSON.parse(Buffer.from(entry.protected, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
  assert.strictEqual(header['kid'], KID);
  assert.strictEqual(header['jku'], JKU);
  assert.strictEqual(typeof header['exp'], 'number');
  assert.strictEqual((await signer.verify(signed, resolverFor(publicJwk))).ok, true);
  // 非法 JWK 不得让启动崩掉，且不得产出签名器。
  assert.strictEqual(A2aAgentCardSigner.fromEnv({ OMNI_A2A_CARD_KEY_JWK: 'not-json' }), undefined);
});

test('JWS ⑦：服务端取卡（getCard / getAuthenticatedExtendedCard）返回可验签的签名卡', async () => {
  const { privateJwk, publicJwk } = makeKeys();
  const signer = new A2aAgentCardSigner({ key: { kid: KID, privateKeyJwk: privateJwk } });
  const identity = new Ed25519AgentIdentity({ agentRuntimeId: 'jws-card-agent' });
  const { client, server } = pair();
  const a2a = new A2aServer(server, identity, { cardSigner: signer });
  a2a.setTaskHandler({ handle: async () => ({ ok: true, output: '', steps: 0, durationMs: 0 }) });
  a2a.setAgentCard(CARD);
  const collect = (id: number): Promise<RpcMessage> =>
    new Promise((resolve) => {
      const previous = client.received.length;
      const timer = setInterval(() => {
        const found = client.received
          .slice(previous)
          .find((message) => 'id' in message && message.id === id);
        if (found !== undefined) {
          clearInterval(timer);
          resolve(found);
        }
      }, 2);
    });
  const cardResponse = collect(1);
  client.send({ jsonrpc: '2.0', id: 1, method: 'agent/getCard', params: {} } as RpcMessage);
  const card = (await cardResponse) as { readonly result?: A2aAgentCard };
  assert.ok(card.result?.signatures !== undefined);
  assert.strictEqual((await signer.verify(card.result, resolverFor(publicJwk))).ok, true);

  const extendedResponse = collect(2);
  client.send({
    jsonrpc: '2.0',
    id: 2,
    method: 'agent/getAuthenticatedExtendedCard',
    params: { assertion: identity.authorizationHeader('jws-card-agent') },
  } as RpcMessage);
  const extended = (await extendedResponse) as { readonly result?: A2aAgentCard };
  assert.ok(extended.result?.signatures !== undefined);
  assert.strictEqual((await signer.verify(extended.result, resolverFor(publicJwk))).ok, true);
});

test('JWS ⑧：HTTP well-known 返回与取卡同源的签名卡（provider 优先于静态卡）', async () => {
  const { privateJwk, publicJwk } = makeKeys();
  const signer = new A2aAgentCardSigner({ key: { kid: KID, privateKeyJwk: privateJwk } });
  const transport = new HttpA2aServerTransport();
  const a2a = new A2aServer(transport, undefined, { cardSigner: signer });
  a2a.setAgentCard(CARD);
  transport.setAgentCardProvider(() => a2a.getAgentCard());
  const port = await transport.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/.well-known/agent-card.json`);
    assert.strictEqual(response.status, 200);
    const card = (await response.json()) as A2aAgentCard;
    assert.strictEqual(card.name, CARD.name);
    assert.ok(card.signatures !== undefined);
    const verdict = await signer.verify(card, resolverFor(publicJwk));
    assert.strictEqual(verdict.ok, true, verdict.reason);
    // 两次请求内容一致（EdDSA 确定性签名；也证明 provider 不是一次性快照）。
    const again = await fetch(`http://127.0.0.1:${String(port)}/.well-known/agent-card.json`);
    assert.deepStrictEqual(await again.json(), card);
  } finally {
    transport.close();
  }
});

test('JWS ⑨：well-known 的 provider 抛错时 500（fail-closed，不回落到旧卡/404）', async () => {
  const transport = new HttpA2aServerTransport();
  transport.setAgentCard(CARD);
  transport.setAgentCardProvider(() => {
    throw new Error('签名服务不可用');
  });
  const port = await transport.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/.well-known/agent-card.json`);
    assert.strictEqual(response.status, 500);
  } finally {
    transport.close();
  }
});
