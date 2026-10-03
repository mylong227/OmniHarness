/**
 * `CancellableModel.reasonOf` 的用例（2026-10-03 第六轮）。
 *
 * 背景（读码发现的两处真缺陷，本文件钉住修复后的口径）：
 *  ① 原白名单只有 `'user' | 'timeout' | 'shutdown' | 'parent'` ⇒ **`'loop-guard'` 与 `{ custom }`
 *     被静默折叠成 `'parent'`**，即"失控熔断"与"自定义原因"都会被谎报成"父令牌级联"；
 *  ② 兜底值与自己 JSDoc 矛盾：文档写"缺省时为 'user'"，实现返回 `'parent'`。
 *
 * 这两条叠加 `CancellationToken.toAbortSignal()` 原先**不带 reason** 调 `abort()` 的缺陷，
 * 使 `CancelledError.reason` 在生产路径上几乎恒为 `'parent'`（`agent.ts` 的取消信号正是经该桥
 * 交给 `CancellableModel`）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CancellableModel } from '../../src/subagent/cancellableModel.js';

/**
 * 造一个"以指定 reason 中止"的 AbortSignal。
 * @param reason 传给 `AbortController.abort` 的原始值。
 * @returns 已中止的信号。
 */
function abortedWith(reason: unknown): AbortSignal {
  const controller = new AbortController();
  controller.abort(reason);
  return controller.signal;
}

test('① 五类结构化原因全部原样还原（含原先被漏掉的 loop-guard）', () => {
  assert.strictEqual(CancellableModel.reasonOf(abortedWith('user')), 'user');
  assert.strictEqual(CancellableModel.reasonOf(abortedWith('timeout')), 'timeout');
  assert.strictEqual(CancellableModel.reasonOf(abortedWith('shutdown')), 'shutdown');
  assert.strictEqual(CancellableModel.reasonOf(abortedWith('parent')), 'parent');
  assert.strictEqual(
    CancellableModel.reasonOf(abortedWith('loop-guard')),
    'loop-guard',
    '失控熔断不得被折叠成 parent（原实现会谎报父级联）',
  );
});

test('② { custom } 对象原因原样还原（不丢自定义文案）', () => {
  const signal = abortedWith({ custom: '业务侧主动放弃' });
  assert.deepStrictEqual(CancellableModel.reasonOf(signal), { custom: '业务侧主动放弃' });
});

test('③ 无结构化原因（通用 AbortError）⇒ 兜底 user，与 JSDoc 一致', () => {
  const controller = new AbortController();
  controller.abort(); // 不传 reason：DOM 会填一个 AbortError
  assert.strictEqual(
    CancellableModel.reasonOf(controller.signal),
    'user',
    '未知原因应兜底 user；原实现返回 parent 属谎报父级联且与文档矛盾',
  );
});

test('④ 未中止的信号与畸形 custom 也不得抛错', () => {
  assert.strictEqual(CancellableModel.reasonOf(new AbortController().signal), 'user');
  assert.strictEqual(CancellableModel.reasonOf(abortedWith({ custom: 123 })), 'user');
  assert.strictEqual(CancellableModel.reasonOf(abortedWith(null)), 'user');
});
