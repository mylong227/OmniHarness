/**
 * `serve` 收尾族判据（2026-11-04 覆盖率四站补测：serveControl 14.81% / serveShutdown 13.79%）。
 *
 * 钉死的口径：
 * - **ServeControl**：只在 `OMNI_CONTROL_STDIO=1` 挂载；`{"type":"shutdown"}` ⇒ CONTROL、
 *   管道 end ⇒ STDIN_EOF、error ⇒ STDIN_ERROR；坏行/未知类型忽略不崩；多行一 chunk 逐行处理；
 * - **ServeShutdown.wait**：收尾顺序 beforeClose → server.close（反了会掐断落盘），
 *   beforeClose 抛错不阻断关服，closing 守卫保证只收一次，实例记录只退役自己的。
 */
import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServeControl } from '../../src/apps/cli/serveControl.ts';
import { ServeShutdown } from '../../src/apps/cli/serveShutdown.ts';
import { ServeInstance } from '../../src/apps/cli/serveInstance.ts';
import type { HttpServer } from '../../src/apps/server/transport/httpServer.ts';

/** 造一个记录 close 调用次序的假服务器。 */
function fakeServer(): { readonly server: HttpServer; readonly calls: string[] } {
  const calls: string[] = [];
  const server = {
    close: async (): Promise<void> => {
      calls.push('close');
    },
  } as unknown as HttpServer;
  return { server, calls };
}

/** 真实实例记录（pid 必须是本进程，retire 才认账）。 */
function instanceFile(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'omni-serveinst-')), 'serve-9.json');
  return ServeInstance.announce(
    {
      pid: process.pid,
      host: '127.0.0.1',
      port: 9,
      startedAt: new Date().toISOString(),
      workspace: '/tmp',
      version: 'test',
    },
    path,
  );
}

test('① ServeControl：OMNI_CONTROL_STDIO ≠ 1 时不挂任何监听', () => {
  const before = process.stdin.listenerCount('data');
  delete process.env['OMNI_CONTROL_STDIO'];
  ServeControl.attach(() => undefined);
  assert.strictEqual(process.stdin.listenerCount('data'), before, '未启用时不得挂载');
});

test('② ServeControl：shutdown 行 ⇒ CONTROL；坏行与未知类型忽略；多行一 chunk 逐行处理', async () => {
  const reasons: string[] = [];
  process.env['OMNI_CONTROL_STDIO'] = '1';
  ServeControl.attach((reason) => reasons.push(reason));
  // 一块 chunk 里三行：shutdown / 坏 JSON / 未知类型 —— 只有第一行触发收尾。
  process.stdin.emit('data', '{"type":"shutdown"}\n{not json}\n{"type":"ping"}\n');
  await vi.waitFor(() => assert.deepStrictEqual(reasons, ['CONTROL']));
  process.stdin.emit('data', '{"type":"shutdown"}\n');
  await vi.waitFor(() => assert.deepStrictEqual(reasons, ['CONTROL', 'CONTROL']));
  process.stdin.removeAllListeners('data');
  process.stdin.removeAllListeners('end');
  process.stdin.removeAllListeners('error');
});

test('③ ServeControl：管道 end ⇒ STDIN_EOF；error ⇒ STDIN_ERROR（父进程崩溃也要能收尾）', async () => {
  const reasons: string[] = [];
  process.env['OMNI_CONTROL_STDIO'] = '1';
  ServeControl.attach((reason) => reasons.push(reason));
  process.stdin.emit('end');
  process.stdin.emit('error', new Error('pipe broken'));
  assert.deepStrictEqual(reasons, ['STDIN_EOF', 'STDIN_ERROR']);
  process.stdin.removeAllListeners('data');
  process.stdin.removeAllListeners('end');
  process.stdin.removeAllListeners('error');
});

test('④ wait：SIGINT ⇒ 顺序 beforeClose → close，resolve 0，退役自己的实例记录', async () => {
  const { server, calls } = fakeServer();
  const path = instanceFile();
  const order: string[] = [];
  const done = ServeShutdown.wait(server, path, async () => {
    order.push('beforeClose');
  });
  process.emit('SIGINT');
  assert.strictEqual(await done, 0);
  order.push('close:done');
  assert.deepStrictEqual(calls, ['close']);
  assert.deepStrictEqual(
    order,
    ['beforeClose', 'close:done'],
    '先收尾再关服（顺序反了会掐断落盘）',
  );
  assert.ok(!existsSync(path), '退役后实例记录应被删除');
});

test('⑤ wait：beforeClose 抛错不阻断关服；SIGTERM 同样收尾', async () => {
  const { server, calls } = fakeServer();
  const done = ServeShutdown.wait(server, undefined, async () => {
    throw new Error('落盘失败也要退出');
  });
  process.emit('SIGTERM');
  assert.strictEqual(await done, 0);
  assert.deepStrictEqual(calls, ['close'], '收尾失败仍必须关服（进程仍要退出）');
});

test('⑥ wait：closing 守卫——二次信号只收一次', async () => {
  const { server, calls } = fakeServer();
  const done = ServeShutdown.wait(server);
  process.emit('SIGINT');
  await done;
  process.emit('SIGINT');
  process.emit('SIGTERM');
  assert.deepStrictEqual(calls, ['close'], 'closing 守卫：重复信号不得二次关服');
});
