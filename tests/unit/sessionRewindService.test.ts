/**
 * 会话回退服务单测（重生成的服务端真回退）。
 *
 * 缺口口径：前端 `regenerate()` 此前只截断视图层事件再重发，服务端 jsonl 里那一轮仍在
 * ⇒ 「重生成」实际是「接着旧答案再来一轮」，刷新后旧回答还复现。本文件把服务端回退的
 * 规则钉住：只保留到指定事件、拒绝半截写入、运行中拒退、找不到事件拒退。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionRewindService } from '../../src/server/services/sessionRewindService.js';
import type { SessionEvent } from '../../src/ports/runtime/event.js';

/** 造事件。 */
const ev = (id: string, type: SessionEvent['type'] = 'user'): SessionEvent => ({
  id,
  type,
  sessionId: 's1',
  timestamp: '2026-09-19T10:00:00.000Z',
  payload: {},
});

/** 造依赖：内存事件流 + 写回记录 + 可控运行态。 */
function makeDeps(events: readonly SessionEvent[], running = false) {
  const saved: { sessionId: string; events: readonly SessionEvent[] }[] = [];
  const deps = {
    replay: async (): Promise<readonly SessionEvent[]> => events,
    save: async (sessionId: string, kept: readonly SessionEvent[]): Promise<void> => {
      saved.push({ sessionId, events: kept });
    },
    isRunning: (): boolean => running,
  };
  return { deps, saved };
}

test('SessionRewindService：截断到指定事件（含），返回保留/丢弃条数', async () => {
  const { deps, saved } = makeDeps([
    ev('u1'),
    ev('a1', 'assistant'),
    ev('u2'),
    ev('a2', 'assistant'),
  ]);
  const out = await new SessionRewindService(deps).rewind('s1', 'u2');
  assert.deepStrictEqual(out, { ok: true, kept: 3, dropped: 1 });
  assert.strictEqual(saved.length, 1, '有截断就必须写回一次');
  assert.deepStrictEqual(
    saved[0]!.events.map((e) => e.id),
    ['u1', 'a1', 'u2'],
    '保留 u2 及其之前，丢弃其后',
  );
});

test('SessionRewindService：keepEventId 已是末条时不写盘（dropped=0）', async () => {
  const { deps, saved } = makeDeps([ev('u1'), ev('a1', 'assistant')]);
  const out = await new SessionRewindService(deps).rewind('s1', 'a1');
  assert.deepStrictEqual(out, { ok: true, kept: 2, dropped: 0 });
  assert.strictEqual(saved.length, 0, '无变化不得写盘（避免无谓落盘与竞态）');
});

test('SessionRewindService：运行中 / 缺参数 / 会话不存在 / 事件不在此会话 一律 fail-closed', async () => {
  const service = new SessionRewindService(makeDeps([ev('u1')], true).deps);
  assert.deepStrictEqual(await service.rewind('s1', 'u1'), {
    ok: false,
    error: '该会话有回合正在运行：请先中止再回退',
  });

  const idle = new SessionRewindService(makeDeps([ev('u1')]).deps);
  assert.strictEqual((await idle.rewind('', 'u1')).ok, false);
  assert.strictEqual((await idle.rewind('s1', '')).ok, false);

  const empty = new SessionRewindService(makeDeps([]).deps);
  const emptyOut = await empty.rewind('s1', 'u1');
  assert.strictEqual(emptyOut.ok, false);
  assert.match(emptyOut.ok === false ? emptyOut.error : '', /会话不存在/);

  const miss = new SessionRewindService(makeDeps([ev('u1')]).deps);
  const out = await miss.rewind('s1', 'nope');
  assert.strictEqual(out.ok, false);
  assert.match(out.ok === false ? out.error : '', /事件不在该会话中/);
});
