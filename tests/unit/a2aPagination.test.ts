/**
 * A2A 1.0 `tasks/list` 游标分页判据（规范 §3.1.4 / §6.5）。
 *
 * 覆盖：页大小与 `nextPageToken` 语义（末页为空串）、稳定排序（时间倒序 + id 兜底）、
 * 非法/被篡改/过期/过滤漂移的 token fail-closed、`pageSize` 越界拒绝，以及经 JSON-RPC
 * 的端到端翻页。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { RpcMessage } from '../../src/server/core/jsonRpc.ts';
import type { A2aTask, A2aTransport } from '../../src/a2a/a2aProtocol.ts';
import { A2aProtocolError } from '../../src/a2a/a2aProtocolError.ts';
import { A2aServer, type TaskHandler } from '../../src/a2a/a2aServer.ts';
import { A2aTaskPager } from '../../src/a2a/a2aTaskPager.ts';

/** 双端内存传输。 */
class MemoryTransport implements A2aTransport {
  public peer: MemoryTransport | undefined;
  private callback: ((message: RpcMessage) => void) | undefined;
  public send(message: RpcMessage): void {
    this.peer?.deliver(message);
  }
  public onMessage(callback: (message: RpcMessage) => void): void {
    this.callback = callback;
  }
  public deliver(message: RpcMessage): void {
    this.callback?.(message);
  }
}

/** 已接线的 JSON-RPC 调用端。 */
interface RpcHarness {
  /** 交给 A2aServer 的服务端侧传输。 */
  readonly serverTransport: MemoryTransport;
  /** 发一条请求并等待同一 id 的响应。 */
  readonly call: (method: string, params: unknown) => Promise<RpcMessage>;
}

/** 建立内存传输对（按 JSON-RPC id 关联响应）。 */
function harness(): RpcHarness {
  const client = new MemoryTransport();
  const server = new MemoryTransport();
  client.peer = server;
  server.peer = client;
  let nextId = 1;
  const pending = new Map<number, (message: RpcMessage) => void>();
  client.onMessage((message) => {
    if (!('id' in message) || typeof message.id !== 'number') return;
    pending.get(message.id)?.(message);
  });
  return {
    serverTransport: server,
    call: (method: string, params: unknown): Promise<RpcMessage> => {
      const id = nextId++;
      return new Promise<RpcMessage>((resolve) => {
        pending.set(id, resolve);
        client.send({ jsonrpc: '2.0', id, method, params } as RpcMessage);
      });
    },
  };
}

/** 构造一条已完成任务（时间戳显式给出，避免依赖真实时钟）。 */
function task(id: string, timestamp: string, contextId?: string): A2aTask {
  return {
    id,
    status: { state: 'completed', timestamp },
    ...(contextId !== undefined ? { contextId } : {}),
  };
}

/** 断言某次调用抛协议错误且错误码为 -32602。 */
function assertInvalid(run: () => unknown, pattern: RegExp): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof A2aProtocolError, `期望 A2aProtocolError，收到 ${String(error)}`);
    assert.strictEqual(error.code, -32602);
    assert.match(error.message, pattern);
    return true;
  });
}

/** 取 JSON-RPC 结果里的任务列表页。 */
function pageOf(message: RpcMessage): {
  readonly tasks: readonly A2aTask[];
  readonly nextPageToken: string;
  readonly pageSize: number;
} {
  const result = (
    message as {
      readonly result?: {
        readonly tasks?: readonly A2aTask[];
        readonly nextPageToken?: string;
        readonly pageSize?: number;
      };
    }
  ).result;
  assert.ok(result !== undefined, `响应缺少 result: ${JSON.stringify(message)}`);
  return {
    tasks: result.tasks ?? [],
    nextPageToken: result.nextPageToken ?? '',
    pageSize: result.pageSize ?? 0,
  };
}

/** 新增 5 条已完成任务（供 JSON-RPC 端到端翻页）。 */
async function seedTasks(rpc: RpcHarness, count: number, contextId: string): Promise<void> {
  for (let index = 1; index <= count; index += 1) {
    const response = await rpc.call('message/send', {
      contextId,
      message: {
        messageId: `seed-${String(index)}`,
        parts: [{ type: 'text', text: `t${String(index)}` }],
      },
    });
    assert.ok('result' in response, `seed 失败: ${JSON.stringify(response)}`);
  }
}

test('分页 ①：pageSize 分页覆盖全部任务，末页 nextPageToken 为空串', () => {
  const pager = new A2aTaskPager({ secret: 'page-test-secret' });
  const all: A2aTask[] = Array.from({ length: 7 }, (_unused, index) =>
    task(`t-${String(index + 1)}`, `2026-10-24T10:00:0${String(index)}.000Z`),
  );
  const first = pager.paginate(all, { pageSize: 3 });
  assert.strictEqual(first.tasks.length, 3);
  assert.strictEqual(first.pageSize, 3);
  assert.notStrictEqual(first.nextPageToken, '');
  assert.deepStrictEqual(
    first.tasks.map((item) => item.id),
    ['t-7', 't-6', 't-5'],
  );
  const second = pager.paginate(all, { pageSize: 3, pageToken: first.nextPageToken });
  assert.deepStrictEqual(
    second.tasks.map((item) => item.id),
    ['t-4', 't-3', 't-2'],
  );
  const third = pager.paginate(all, { pageSize: 3, pageToken: second.nextPageToken });
  assert.deepStrictEqual(
    third.tasks.map((item) => item.id),
    ['t-1'],
  );
  assert.strictEqual(third.nextPageToken, '', '末页必须返回空串（字段恒存在）');
});

test('分页 ②：同时间戳按 id 倒序兜底，翻页不重复不遗漏', () => {
  const pager = new A2aTaskPager({ secret: 'page-test-secret' });
  const stamp = '2026-10-24T11:00:00.000Z';
  const all: A2aTask[] = [task('a', stamp), task('c', stamp), task('b', stamp)];
  const first = pager.paginate(all, { pageSize: 2 });
  assert.deepStrictEqual(
    first.tasks.map((item) => item.id),
    ['c', 'b'],
  );
  const second = pager.paginate(all, { pageSize: 2, pageToken: first.nextPageToken });
  assert.deepStrictEqual(
    second.tasks.map((item) => item.id),
    ['a'],
  );
  assert.strictEqual(second.nextPageToken, '');
  const seen = [...first.tasks, ...second.tasks].map((item) => item.id);
  assert.deepStrictEqual(new Set(seen).size, 3, '翻页不得重复');
});

test('分页 ③：非法 / 被篡改 / 换密钥的 token 一律 fail-closed（-32602）', () => {
  const pager = new A2aTaskPager({ secret: 'page-test-secret' });
  const all: A2aTask[] = [
    task('t-2', '2026-10-24T12:00:02.000Z'),
    task('t-1', '2026-10-24T12:00:01.000Z'),
  ];
  assertInvalid(() => pager.paginate(all, { pageSize: 1, pageToken: 'not-a-token' }), /结构/u);
  const issued = pager.paginate(all, { pageSize: 1 }).nextPageToken;
  const parts = issued.split('.');
  const mac = parts[1] ?? '';
  const flipped = `${parts[0] ?? ''}.${mac.slice(0, -1)}${mac.endsWith('A') ? 'B' : 'A'}`;
  assertInvalid(() => pager.paginate(all, { pageSize: 1, pageToken: flipped }), /签名/u);
  const foreign = new A2aTaskPager({ secret: 'another-secret' });
  assertInvalid(() => foreign.paginate(all, { pageSize: 1, pageToken: issued }), /签名/u);
});

test('分页 ④：过滤条件与签发时不符时拒绝游标（不静默错序）', () => {
  const pager = new A2aTaskPager({ secret: 'page-test-secret' });
  const all: A2aTask[] = [
    task('a-2', '2026-10-24T13:00:02.000Z', 'ctx-a'),
    task('a-1', '2026-10-24T13:00:01.000Z', 'ctx-a'),
    task('b-1', '2026-10-24T13:00:03.000Z', 'ctx-b'),
  ];
  const issued = pager.paginate(all, { pageSize: 1, contextId: 'ctx-a' });
  assert.deepStrictEqual(
    issued.tasks.map((item) => item.id),
    ['a-2'],
  );
  assertInvalid(
    () => pager.paginate(all, { pageSize: 1, pageToken: issued.nextPageToken, contextId: 'ctx-b' }),
    /过滤条件/u,
  );
  assertInvalid(
    () => pager.paginate(all, { pageSize: 1, pageToken: issued.nextPageToken }),
    /过滤条件/u,
  );
  // 同一过滤条件下游标可用。
  const next = pager.paginate(all, {
    pageSize: 1,
    pageToken: issued.nextPageToken,
    contextId: 'ctx-a',
  });
  assert.deepStrictEqual(
    next.tasks.map((item) => item.id),
    ['a-1'],
  );
});

test('分页 ⑤：过期 token 拒绝（TTL 由注入时钟判定）', () => {
  let now = 1_000_000;
  const pager = new A2aTaskPager({
    secret: 'page-test-secret',
    ttlMs: 1_000,
    now: () => now,
  });
  const all: A2aTask[] = [
    task('t-2', '2026-10-24T14:00:02.000Z'),
    task('t-1', '2026-10-24T14:00:01.000Z'),
  ];
  const first = pager.paginate(all, { pageSize: 1 });
  assert.notStrictEqual(first.nextPageToken, '');
  now += 5_000;
  assertInvalid(
    () => pager.paginate(all, { pageSize: 1, pageToken: first.nextPageToken }),
    /过期/u,
  );
});

test('分页 ⑥：pageSize 越界/非整数一律 -32602；缺省为 50', () => {
  const pager = new A2aTaskPager({ secret: 'page-test-secret' });
  const all: A2aTask[] = [task('t-1', '2026-10-24T15:00:00.000Z')];
  assertInvalid(() => pager.paginate(all, { pageSize: 0 }), /pageSize/u);
  assertInvalid(() => pager.paginate(all, { pageSize: 101 }), /pageSize/u);
  assertInvalid(() => pager.paginate(all, { pageSize: 2.5 }), /pageSize/u);
  assertInvalid(() => pager.paginate(all, { pageSize: '10' }), /pageSize/u);
  const page = pager.paginate(all, {});
  assert.strictEqual(page.pageSize, 50);
  assert.strictEqual(page.tasks.length, 1);
});

test('分页 ⑦：JSON-RPC tasks/list 端到端翻页（含非法 token 错误码）', async () => {
  const rpc = harness();
  const pager = new A2aTaskPager({ secret: 'json-rpc-secret' });
  const server = new A2aServer(rpc.serverTransport, undefined, { pager });
  const handler: TaskHandler = {
    async handle(request) {
      return { ok: true, output: `ok:${request.task}`, steps: 1, durationMs: 1 };
    },
  };
  server.setTaskHandler(handler);
  await seedTasks(rpc, 5, 'ctx-page');
  const seen: string[] = [];
  let token = '';
  let pages = 0;
  do {
    const page = pageOf(
      await rpc.call('tasks/list', {
        contextId: 'ctx-page',
        pageSize: 2,
        ...(token !== '' ? { pageToken: token } : {}),
      }),
    );
    assert.strictEqual(page.pageSize, 2);
    assert.ok(page.tasks.length <= 2);
    seen.push(...page.tasks.map((item) => item.id));
    token = page.nextPageToken;
    pages += 1;
    assert.ok(pages <= 5, '翻页次数异常（可能没有前进）');
  } while (token !== '');
  assert.strictEqual(seen.length, 5);
  assert.strictEqual(new Set(seen).size, 5, '端到端翻页不得重复');
  assert.strictEqual(pages, 3, '5 条 / 每页 2 条 = 3 页');

  const invalid = await rpc.call('tasks/list', { pageToken: 'forged-token', pageSize: 2 });
  const error = (invalid as { readonly error?: { readonly code?: number } }).error;
  assert.strictEqual(error?.code, -32602);
});

test('分页 ⑧：state 过滤 + 分页组合（列表只含匹配状态）', async () => {
  const rpc = harness();
  const server = new A2aServer(rpc.serverTransport, undefined, {
    pager: new A2aTaskPager({ secret: 'state-filter-secret' }),
  });
  server.setTaskHandler({
    async handle(request) {
      return { ok: true, output: `ok:${request.task}`, steps: 1, durationMs: 1 };
    },
  });
  await seedTasks(rpc, 3, 'ctx-state');
  const page = pageOf(
    await rpc.call('tasks/list', { state: 'completed', pageSize: 2, contextId: 'ctx-state' }),
  );
  assert.strictEqual(page.tasks.length, 2);
  assert.ok(page.tasks.every((item) => item.status.state === 'completed'));
  const empty = pageOf(
    await rpc.call('tasks/list', { state: 'working', pageSize: 2, contextId: 'ctx-state' }),
  );
  assert.deepStrictEqual(empty.tasks, []);
  assert.strictEqual(empty.nextPageToken, '');
  // 规范 ProtoJSON 名同样可过滤（互操作别名归一：TASK_STATE_COMPLETED → completed）。
  const specName = pageOf(
    await rpc.call('tasks/list', {
      state: 'TASK_STATE_COMPLETED',
      pageSize: 3,
      contextId: 'ctx-state',
    }),
  );
  assert.strictEqual(specName.tasks.length, 3);
});
