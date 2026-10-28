/**
 * 工具级资源域闸判据（2026-10-28，BLOCKERS §5 收口）。
 *
 * 真实争抢背景：BrowserSession 跨调用复用同一浏览器 ⇒ 两个会话并发调 browser 工具
 * 互踩同一标签页。判据验证：跨会话串行、未声明工具零开销、开关关闭零行为、
 * 取消不泄漏锁、声明表覆盖浏览器两工具。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ToolResourceGate } from '../../src/core/toolResourceGate.ts';
import { LockError } from '../../src/util/concurrency/lockError.ts';
import { TOOL_NAMES } from '../../src/ports/tool/toolNames.ts';
import { TOOL_RESOURCE_DOMAINS } from '../../src/ports/tool/toolResourceDomains.ts';

test('声明表：浏览器两工具都绑 browser 写域；未声明工具返回空', () => {
  assert.deepStrictEqual(TOOL_RESOURCE_DOMAINS[TOOL_NAMES.browserAct], [
    { domain: 'browser', mode: 'write' },
  ]);
  assert.deepStrictEqual(TOOL_RESOURCE_DOMAINS[TOOL_NAMES.browserScreenshot], [
    { domain: 'browser', mode: 'write' },
  ]);
  assert.strictEqual(
    TOOL_RESOURCE_DOMAINS[TOOL_NAMES.readFile],
    undefined,
    '未声明工具在表中无键（闸按空域处理）',
  );
  assert.strictEqual(
    TOOL_RESOURCE_DOMAINS[TOOL_NAMES.shell],
    undefined,
    'shell 已有公平闸门，不重复锁',
  );
  // 表内每个键都必须是已登记工具名（防拼写漂移）。
  const known = new Set(Object.values(TOOL_NAMES));
  for (const key of Object.keys(TOOL_RESOURCE_DOMAINS)) {
    assert.ok(known.has(key as never), `声明表键 ${key} 必须在 TOOL_NAMES 内`);
  }
});

test('跨会话互斥：同域写锁串行（第二会话等待），释放后立即授予', async () => {
  const gate = new ToolResourceGate({});
  const order: string[] = [];
  const release1 = await gate.acquire(TOOL_NAMES.browserAct, 'session-a');
  const second = gate.acquire(TOOL_NAMES.browserScreenshot, 'session-b').then((release) => {
    order.push('b-acquired');
    return release;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  order.push('a-still-holding');
  assert.deepStrictEqual(order, ['a-still-holding'], 'a 未释放前 b 不得进入');
  release1();
  const release2 = await second;
  assert.strictEqual(order[1], 'b-acquired');
  release2();
  // 释放后锁表应清空（空闲即删 key，防长跑进程无界增长）。
  assert.strictEqual(gate.stats().keys, 0);
});

test('开关：OMNI_TOOL_DOMAIN_LOCKS=0 时全部立即返回空释放（零行为变更）', async () => {
  const gate = new ToolResourceGate({ OMNI_TOOL_DOMAIN_LOCKS: '0' });
  const r1 = await gate.acquire(TOOL_NAMES.browserAct, 'session-a');
  const r2 = await gate.acquire(TOOL_NAMES.browserAct, 'session-b');
  r1();
  r2();
  assert.strictEqual(gate.stats().keys, 0, '关闭时不持任何锁（两个会话可同时进）');
});

test('取消：等待期 abort 以 LockError 拒绝，且不泄漏持锁/排队状态', async () => {
  const gate = new ToolResourceGate({});
  const release = await gate.acquire(TOOL_NAMES.browserAct, 'session-a');
  const controller = new AbortController();
  const waiting = gate.acquire(TOOL_NAMES.browserAct, 'session-b', controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  await assert.rejects(() => waiting, LockError);
  release();
  assert.strictEqual(gate.stats().waiters, 0, '被取消的等待者必须出队');
  assert.strictEqual(gate.stats().keys, 0, '全部释放后锁表清空');
  // 闸仍可用：下一个获取照常成功。
  const next = await gate.acquire(TOOL_NAMES.browserAct, 'session-c');
  next();
  assert.strictEqual(gate.stats().keys, 0);
});
