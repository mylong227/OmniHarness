/**
 * 小型稳定性加固项的合并回归（2026-09-26 审计 S14 / S18 / S24 / S26 / S28）。
 *
 * 五项都不是「功能缺失」，而是**静默失效**：调用方以为成功、实际永久挂起或悄悄丢数据。
 * 每项一个可证伪断言。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PendingRequests } from '../../src/util/pendingRequests.js';
import { SdkClient } from '../../src/sdk/sdkClient.js';
import type { SdkSocket } from '../../src/sdk/webSocketSdkSocket.js';
import { Interactive } from '../../src/tui/interactive.js';
import { RoutineScheduler } from '../../src/daemon/routineScheduler.js';
import { FileLongTermMemory } from '../../src/adapters/memory/fileLongTermMemory.js';

/** 等待若干毫秒（超时类断言需要真实时钟）。 */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('S28：同一 key 重复登记时旧超时定时器必须被清掉（否则新请求被旧阈值提前收尾）', async () => {
  const pending = new PendingRequests<string, string>();
  const settled: string[] = [];
  pending.register(
    'k',
    { resolve: () => settled.push('first') },
    { ms: 30, onTimeout: () => settled.push('first-timeout') },
  );
  // 覆盖登记：新条目**不设超时**。旧定时器若未清，会在 30ms 到点时 `onTimeout → take('k')`
  // 取到**新**条目，把它移出表并调用**旧的** onTimeout ⇒ 新请求被旧阈值提前收尾。
  pending.register('k', { resolve: () => settled.push('second') });
  await wait(90);
  assert.deepStrictEqual(settled, [], `新请求被旧定时器提前收尾：${settled.join(',')}`);
  // 新条目仍可正常兑现 —— 证明它既没被提前收尾也没被移出表。
  assert.strictEqual(pending.settle('k', 'ok'), true, '新条目应仍在表内');
});

test('S14：socket 在 open 之前 close ⇒ call() 必须 reject（而不是永久挂起）', async () => {
  // 注意：`bindSocket` 会**注册两个** onClose（其一是兑现 opened、其二是 failAll）——
  // 桩必须把两者都存下来并全部触发，否则测的是「桩没实现好」而不是产品行为。
  const closeHandlers: (() => void)[] = [];
  const socket: SdkSocket = {
    send: () => undefined,
    close: () => undefined,
    onOpen: () => undefined,
    onMessage: () => undefined,
    onClose: (handler) => {
      closeHandlers.push(handler);
    },
    onError: () => undefined,
  };
  const client = new SdkClient({ socket, timeoutMs: 10_000 });
  assert.ok(closeHandlers.length >= 1, '前置条件：应已注册 onClose');
  for (const handler of closeHandlers) handler();
  await assert.rejects(
    () => client.call('ping', {}),
    /关闭/,
    '未就绪即断开时，call() 必须以「连接关闭」失败，不得挂起',
  );
});

test('S24：定时任务存储损坏时隔离并抛错（不得静默清空后把空表写回）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-routines-'));
  const storePath = join(dir, 'routines.json');
  try {
    writeFileSync(storePath, '{"routines":[{"id":"a"', 'utf8'); // 截断的非法 JSON
    const scheduler = new RoutineScheduler(storePath);
    assert.throws(() => scheduler.list(), /损坏/, '损坏存储必须显式抛错');
    const quarantined = readdirSync(dir).filter((name) => name.includes('.corrupt-'));
    assert.strictEqual(quarantined.length, 1, '应留下隔离副本（供人工修复）');
    assert.strictEqual(
      readFileSync(join(dir, quarantined[0] ?? ''), 'utf8'),
      '{"routines":[{"id":"a"',
      '隔离副本必须是原始内容，不得被改写',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S24：任务存储落盘走 tmp+rename（中途不产生截断的半份 JSON）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-routines-'));
  const storePath = join(dir, 'routines.json');
  try {
    const scheduler = new RoutineScheduler(storePath);
    scheduler.add({
      name: 'n',
      prompt: 'p',
      modelAdapter: 'openai',
      schedule: { kind: 'interval', minutes: 5 },
    });
    const parsed = JSON.parse(readFileSync(storePath, 'utf8')) as { routines: unknown[] };
    assert.strictEqual(parsed.routines.length, 1, '写入应完整可解析');
    assert.ok(!readdirSync(dir).includes('routines.json.tmp'), '临时文件不得残留');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S26：落盘失败必须留痕（结构化 warn），且内存态仍保留该事实', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-ltm-'));
  // 把记忆文件的**父路径**做成普通文件：mkdirSync(dirname) 必因 ENOTDIR 失败 ⇒ append 必失败。
  const blocker = join(dir, 'sub');
  writeFileSync(blocker, 'not a directory', 'utf8');
  const original = process.stderr.write.bind(process.stderr);
  const lines: string[] = [];
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
  try {
    const memory = new FileLongTermMemory(join(blocker, 'memory.jsonl'));
    memory.remember({
      id: 'f1',
      text: 'hello world',
      importance: 3,
      createdAt: new Date().toISOString(),
      sessionId: 's1',
      source: 'tool',
    });
    const warns = lines
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry['msg'] === 'memory.longterm.persist_failed');
    assert.strictEqual(warns.length, 1, `应恰好一条持久化失败告警，实际日志：${lines.join('')}`);
    assert.strictEqual(warns[0]?.['level'], 'warn');
    assert.strictEqual(memory.recall('hello', 5).length, 1, '内存态仍应可召回该事实');
  } finally {
    process.stderr.write = original;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S18：stdin 结束时交互式会话必须退出（EOF 分支不得是死代码）', async () => {
  let closeHandler: (() => void) | undefined;
  const fakeRl = {
    question: (): void => {
      // 真实 readline 在 EOF 时**不调用** question 回调，只发 'close'。
    },
    once: (event: string, handler: () => void): void => {
      if (event === 'close') closeHandler = handler;
    },
    removeListener: (): void => undefined,
  };
  let sent = 0;
  const done = Interactive.startInteractive({
    rl: fakeRl as never,
    out: { write: () => true } as never,
    send: () => {
      sent += 1;
      return (async function* () {})();
    },
  });
  // 模拟 stdin 结束。
  closeHandler?.();
  await Promise.race([
    done,
    wait(500).then(() => {
      throw new Error('stdin 结束后 startInteractive 仍未返回（EOF 分支失效）');
    }),
  ]);
  assert.strictEqual(sent, 0, 'EOF 不应触发任何发送');
});
