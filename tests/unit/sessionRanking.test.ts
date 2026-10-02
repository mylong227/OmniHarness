// 会话排序 v2（显式名次 + 新会话置顶 + 历史垫后）的纯逻辑门禁。
//
// ## 为什么有这一版（2026-09-27 用户点名「另一个客户端新建的会话仍被排在已登记项之后」）
//
// v1 只存 id 数组，语义是「登记过的在前、未登记的按时间倒序垫后」：单客户端没问题，但**另一个客户端**
// 刚建的会话会被当成「未登记」而垫到列表底部 —— 用户刚聊过的会话跑到最下面。
// v2 分三层：新会话（上次排序之后出现）置顶 → 用户显式排过的按名次 → 升级前的历史会话垫后。
//
// 覆盖：v1 兼容解析、三层排序键、稠密名次（未提交但已登记的会话保序接在后面）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionRanking } from '../../src/server/services/session/sessionRanking.js';

test('解析：v1 数组 ⇒ 下标即名次，且 at=0（历史会话不会被凭空提到最前）', () => {
  const doc = SessionRanking.parse(['b', 'a']);
  assert.deepEqual(doc.rank, { b: 0, a: 1 });
  assert.strictEqual(doc.at, 0);
});

test('解析：v2 文档原样读出；坏字段逐个丢弃并回落 at=0', () => {
  const doc = SessionRanking.parse({ v: 2, at: 1234, rank: { a: 0, b: 'x', c: 2 } });
  assert.deepEqual(doc.rank, { a: 0, c: 2 });
  assert.strictEqual(doc.at, 1234);
  assert.deepEqual(SessionRanking.parse('nonsense'), { rank: {}, at: 0 });
  assert.deepEqual(SessionRanking.parse(null), { rank: {}, at: 0 });
});

test('三层排序键：新会话在前、显式名次居中、历史未登记垫后', () => {
  const at = 1_000;
  const fresh = SessionRanking.sortKey(undefined, 2_000, at); // 上次排序之后出现
  const ranked = SessionRanking.sortKey(5, 500, at);
  const legacy = SessionRanking.sortKey(undefined, 900, at); // 早于上次排序
  assert.ok(SessionRanking.compare(fresh, ranked) < 0, '新会话必须排在显式顺序之前');
  assert.ok(SessionRanking.compare(ranked, legacy) < 0, '显式顺序必须排在历史未登记之前');
});

test('同层内按时间倒序：多个新会话最新的在最前', () => {
  const at = 1_000;
  const newer = SessionRanking.sortKey(undefined, 3_000, at);
  const older = SessionRanking.sortKey(undefined, 2_000, at);
  assert.ok(SessionRanking.compare(newer, older) < 0);
});

test('稠密名次：提交的按提交顺序 0..n-1，未提交但已登记的保序接在后面', () => {
  const prev = { rank: { a: 0, b: 1, c: 2, z: 9 }, at: 111 };
  const doc = SessionRanking.densify(['c', 'a'], prev, 999);
  assert.deepEqual(doc.rank, { c: 0, a: 1, b: 2, z: 3 });
  assert.strictEqual(doc.at, 999, 'at 必须推进到本次排序时刻（此后新会话才算「新」）');
});

test('稠密名次：重复 id 只取首次出现（拖拽落点可能重复提交）', () => {
  const doc = SessionRanking.densify(['a', 'a', 'b'], { rank: {}, at: 0 }, 5);
  assert.deepEqual(doc.rank, { a: 0, b: 1 });
});
