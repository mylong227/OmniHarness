/**
 * 服务端暴露守卫单测（2026-09-19 审计发现的真缺口）。
 *
 * 缺口口径：`httpServer.listen(port)` 未传地址 ⇒ Node 默认绑 `0.0.0.0`，而该服务能驱动
 * agent 执行任意工具（含 `--auto-approve`）⇒ 等于把「无鉴权的远程执行入口」开到局域网。
 * 本文件把修好后的规则钉住：默认回环、非回环必须配令牌、配了令牌则 HTTP 与 WS 都要过门。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { resolve } from 'node:path';
import { ServerAuthGuard } from '../../src/server/transport/serverAuthGuard.js';

/** 造一条最小请求对象（只带守卫关心的字段）。 */
const req = (url: string, authorization?: string): IncomingMessage =>
  ({ url, headers: authorization === undefined ? {} : { authorization } }) as IncomingMessage;

test('ServerAuthGuard：默认地址是回环，回环判定覆盖 127.0.0.1/::1/localhost', () => {
  assert.strictEqual(ServerAuthGuard.DEFAULT_HOST, '127.0.0.1');
  for (const host of ['127.0.0.1', '::1', 'localhost', '[::1]', ' 127.0.0.1 ']) {
    assert.strictEqual(ServerAuthGuard.isLoopback(host), true, `${host} 应判为回环`);
  }
  for (const host of ['0.0.0.0', '192.168.1.5', '::', 'example.com']) {
    assert.strictEqual(ServerAuthGuard.isLoopback(host), false, `${host} 不应判为回环`);
  }
});

test('ServerAuthGuard.assertBindSafe：非回环且无令牌必须拒绝启动（fail-closed）', () => {
  assert.doesNotThrow(() => ServerAuthGuard.assertBindSafe('127.0.0.1', undefined));
  assert.doesNotThrow(() => ServerAuthGuard.assertBindSafe('0.0.0.0', 'secret'));
  assert.throws(
    () => ServerAuthGuard.assertBindSafe('0.0.0.0', undefined),
    /拒绝以 0\.0\.0\.0 启动[\s\S]*OMNI_SERVE_TOKEN/,
    '裸奔的非回环绑定必须被拒，并给出可执行出路',
  );
  assert.throws(() => ServerAuthGuard.assertBindSafe('192.168.1.5', ''), /必须配令牌/);
});

test('ServerAuthGuard.verify：未配令牌全放行；配了令牌则要求 Bearer 且常量时间比较', () => {
  const open = new ServerAuthGuard(undefined);
  assert.strictEqual(open.enabled, false);
  assert.strictEqual(open.verify(req('/rpc')), true, '未配令牌时保持既有行为（本机单用户）');

  const guard = new ServerAuthGuard('s3cret');
  assert.strictEqual(guard.enabled, true);
  assert.strictEqual(guard.verify(req('/rpc')), false, '无头必须拒');
  assert.strictEqual(guard.verify(req('/rpc', 's3cret')), false, '缺 Bearer 前缀必须拒');
  assert.strictEqual(guard.verify(req('/rpc', 'Bearer wrong')), false, '错令牌必须拒');
  assert.strictEqual(guard.verify(req('/rpc', 'Bearer s3cret')), true, '正确令牌放行');
  assert.strictEqual(guard.verify(req('/healthz')), true, '存活探针不鉴权（不泄露任何数据）');
  assert.strictEqual(guard.verify(req('/healthz?x=1')), true, '带查询串的探针同样放行');
});

/**
 * 起一个真实 AppServer + HttpServer（与 `httpServer.test.ts` 同款装配）。
 *
 * @param authToken 令牌（缺省不启用鉴权）。
 * @param host 绑定地址（缺省回环）。
 * @returns 服务器实例与端口。
 */
async function startRealServer(
  authToken?: string,
  host?: string,
): Promise<{
  server: import('../../src/server/transport/httpServer.js').HttpServer;
  port: number;
}> {
  const { HttpServer, HttpBridgeTransport } =
    await import('../../src/server/transport/httpServer.js');
  const { AppServer } = await import('../../src/server/core/appServer.js');
  const { ConfigFactory } = await import('../../src/config/configFactory.js');
  const { MockModel } = await import('../../src/adapters/model/mockModel.js');
  const { MemoryStorage } = await import('../../src/adapters/storage/memoryStorage.js');
  const { SilentEventPort } = await import('../../src/adapters/event/silentEventPort.js');
  const { AutoApproval } = await import('../../src/adapters/approval/autoApproval.js');
  const { PassthroughSandbox } = await import('../../src/adapters/sandbox/passthroughSandbox.js');
  const { tempWorkspace } = await import('../helpers/tempWorkspace.js');

  const config = ConfigFactory.build({
    workspaceRoot: tempWorkspace(),
    maxSteps: 16,
    model: new MockModel(),
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
  });
  const bridge = new HttpBridgeTransport();
  const app = new AppServer({ config, transport: bridge, modelOverrideEnabled: false });
  const server = new HttpServer({
    app,
    bridge,
    webDir: resolve(process.cwd(), 'web'),
    ...(authToken !== undefined ? { authToken } : {}),
    ...(host !== undefined ? { host } : {}),
  });
  const port = await server.start(0);
  return { server, port };
}

test('真机：HttpServer 默认绑回环、带令牌时 /rpc 401 而 /healthz 放行', async () => {
  const { server, port } = await startRealServer('tok-123');
  try {
    const addr = (
      server as unknown as { server: { address(): { address?: string } } }
    ).server.address();
    assert.strictEqual(addr.address, '127.0.0.1', `默认必须绑回环，实际 ${String(addr.address)}`);

    const call = (path: string, headers: Record<string, string>): Promise<number> =>
      new Promise((resolveStatus, reject) => {
        const r = httpRequest({ host: '127.0.0.1', port, path, method: 'POST', headers }, (res) => {
          res.resume();
          res.on('end', () => resolveStatus(res.statusCode ?? 0));
        });
        r.on('error', reject);
        r.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }));
      });

    assert.strictEqual(await call('/rpc', {}), 401, '无令牌必须 401');
    assert.strictEqual(
      await call('/rpc', { authorization: 'Bearer tok-123', 'content-type': 'application/json' }),
      200,
      '正确令牌必须放行',
    );

    const health = await new Promise<number>((resolveStatus, reject) => {
      const r = httpRequest({ host: '127.0.0.1', port, path: '/healthz', method: 'GET' }, (res) => {
        res.resume();
        res.on('end', () => resolveStatus(res.statusCode ?? 0));
      });
      r.on('error', reject);
      r.end();
    });
    assert.strictEqual(health, 200, '存活探针无需令牌');
  } finally {
    await server.close();
  }
});

test('真机：非回环绑定缺少令牌时拒绝启动（不起半个服务）', async () => {
  await assert.rejects(() => startRealServer(undefined, '0.0.0.0'), /必须配令牌/);
});

test('真机：WS 升级同样过鉴权门（无令牌 401，不静默升成裸连）', async () => {
  const net = await import('node:net');
  const { server, port } = await startRealServer('ws-tok');
  try {
    const status = await new Promise<string>((resolveStatus, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write(
          'GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
        );
      });
      let buf = '';
      socket.on('data', (chunk) => {
        buf += String(chunk);
      });
      socket.on('close', () => resolveStatus(buf.split('\r\n')[0] ?? ''));
      socket.on('error', reject);
      setTimeout(() => socket.destroy(), 500);
    });
    assert.match(status, /401/, `无令牌的 WS 升级必须 401，实际「${status}」`);
  } finally {
    await server.close();
  }
});
