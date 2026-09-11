import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { Duplex } from 'node:stream';
import { HttpBridgeTransport } from '../../src/server/httpServer.js';
import { WsConnection } from '../../src/server/wsConnection.js';
import { jsonRpc, type RpcResponse } from '../../src/server/jsonRpc.js';
import { EnterpriseAuth, type OidcDiscovery } from '../../src/enterprise/oidcClient.js';

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

const REQ = { jsonrpc: '2.0', id: 1, method: 'config.get' } as const;

/** 构造带本地 JWKS 的 EnterpriseAuth + 一枚有效 Bearer 令牌。 */
function makeAuth(): { auth: EnterpriseAuth; token: string } {
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
        { headers: { 'content-type': 'application/json' } },
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
  return { auth, token };
}

/** 把 bridge 接到一个记录分发动作的回调；分发成功时回送响应以解除 pending。 */
function wireBridge(bridge: HttpBridgeTransport, dispatched: string[]): void {
  bridge.onMessage((message) => {
    if ('method' in message) {
      dispatched.push(message.method);
    }
    if ('id' in message) {
      bridge.send(jsonRpc.response(message.id, { ok: true }));
    }
  });
}

test('POST 门禁关闭时：无头也能调用', async () => {
  const bridge = new HttpBridgeTransport();
  const dispatched: string[] = [];
  wireBridge(bridge, dispatched);
  const res = (await bridge.handlePost(JSON.stringify(REQ))) as RpcResponse;
  assert.strictEqual((res.result as { ok: boolean }).ok, true);
  assert.deepStrictEqual(dispatched, ['config.get']);
});

test('POST 门禁开启 + 有效令牌：放行', async () => {
  const { auth, token } = makeAuth();
  const bridge = new HttpBridgeTransport(auth);
  const dispatched: string[] = [];
  wireBridge(bridge, dispatched);
  const res = (await bridge.handlePost(JSON.stringify(REQ), 'Bearer ' + token)) as RpcResponse;
  assert.strictEqual((res.result as { ok: boolean }).ok, true);
  assert.deepStrictEqual(dispatched, ['config.get']);
});

test('POST 门禁开启 + 无效令牌：fail-closed 拒绝 (-32001)', async () => {
  const { auth } = makeAuth();
  const bridge = new HttpBridgeTransport(auth);
  const dispatched: string[] = [];
  wireBridge(bridge, dispatched);
  const res = (await bridge.handlePost(JSON.stringify(REQ), 'Bearer garbage')) as RpcResponse;
  assert.strictEqual(res.error?.code, -32001);
  assert.deepStrictEqual(dispatched, []);
});

test('POST 门禁开启 + 缺 Authorization 头：fail-closed 拒绝 (-32001)', async () => {
  const { auth } = makeAuth();
  const bridge = new HttpBridgeTransport(auth);
  const dispatched: string[] = [];
  wireBridge(bridge, dispatched);
  const res = (await bridge.handlePost(JSON.stringify(REQ))) as RpcResponse;
  assert.strictEqual(res.error?.code, -32001);
  assert.deepStrictEqual(dispatched, []);
});

// ---- WS 通道门禁 ----
function makeFakeConnection(authorization?: string): { conn: WsConnection; writes: string[] } {
  const writes: string[] = [];
  const socket = {
    on: () => undefined,
    write: (b: Buffer | string) => {
      // WsConnection.send 写入 [0x81, len, ...payload] 帧；剥离 2 字节头取 JSON 负载。
      writes.push(Buffer.from(b).subarray(2).toString('utf8'));
      return true;
    },
    end: () => undefined,
    destroy: () => undefined,
  } as unknown as Duplex;
  const conn = new WsConnection(socket, authorization);
  return { conn, writes };
}

test('WS 门禁开启 + 有效令牌：放行并回送响应', async () => {
  const { auth, token } = makeAuth();
  const bridge = new HttpBridgeTransport(auth);
  const dispatched: string[] = [];
  wireBridge(bridge, dispatched);
  const { conn, writes } = makeFakeConnection('Bearer ' + token);
  bridge.registerWs(conn);
  conn.onMessage(JSON.stringify(REQ));
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(dispatched, ['config.get']);
  const sent = JSON.parse(writes[0]!) as RpcResponse;
  assert.strictEqual((sent.result as { ok: boolean }).ok, true);
});

test('WS 门禁开启 + 无效令牌：fail-closed 拒绝 (-32001)', async () => {
  const { auth } = makeAuth();
  const bridge = new HttpBridgeTransport(auth);
  const dispatched: string[] = [];
  wireBridge(bridge, dispatched);
  const { conn, writes } = makeFakeConnection('Bearer garbage');
  bridge.registerWs(conn);
  conn.onMessage(JSON.stringify(REQ));
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(dispatched, []);
  const sent = JSON.parse(writes[0]!) as RpcResponse;
  assert.strictEqual(sent.error?.code, -32001);
});
