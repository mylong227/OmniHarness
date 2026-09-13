// T3.4（REFACTOR_BOARD）· 重置点 + 交接物（scratchpad）可证伪验收：
//   ① 跨重置恢复：写入交接物 → 重新构造实例（等价进程重启/上下文重置）→ 读回最新便签，任务可恢复；
//   ② 有界性：超过 maxNotes 丢最旧；
//   ③ fail-soft：文件损坏/空正文一律回空态，绝不抛错阻断主流程。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileScratchpad } from '../../src/adapters/memory/fileScratchpad.js';

function tmpWs(): string {
  return mkdtempSync(join(tmpdir(), 'omni-scratch-'));
}

test('① 跨重置恢复：写交接物 → 新实例（模拟重置）→ 读回即恢复任务', () => {
  const ws = tmpWs();
  const first = new FileScratchpad(() => ws);
  first.append('任务：重构 moduleA；已完成导出迁移；下一步：更新 import（勿动 tests/）', [
    'handoff',
    'reset-point',
  ]);

  // 上下文重置 = 新实例（同工作区）。旧实例的内存态对新实例不可见。
  const afterReset = new FileScratchpad(() => ws);
  const note = afterReset.latest();
  assert.ok(note, '重置后必须能读到交接物');
  assert.match(note!.text, /moduleA/);
  assert.match(note!.text, /下一步：更新 import/);
  assert.deepStrictEqual(note!.tags, ['handoff', 'reset-point']);

  // recent 倒序（新在前）。
  first.append('第二条：import 已更新 3/17 个文件', ['progress']);
  const recent = afterReset.recent(2);
  assert.strictEqual(recent.length, 2);
  assert.match(recent[0]!.text, /3\/17/);
  assert.match(recent[1]!.text, /moduleA/);
  rmSync(ws, { recursive: true, force: true });
});

test('② 有界性：超出 maxNotes 丢最旧（交接物是热数据不是档案）', () => {
  const ws = tmpWs();
  const pad = new FileScratchpad(() => ws, { maxNotes: 3 });
  pad.append('n1');
  pad.append('n2');
  pad.append('n3');
  pad.append('n4');
  const texts = pad.recent(10).map((n) => n.text);
  assert.deepStrictEqual(texts, ['n4', 'n3', 'n2'], '应只保留最近 3 条且新在前');
  rmSync(ws, { recursive: true, force: true });
});

test('③ fail-soft：文件损坏回空态、空正文拒收、clear 幂等，全程不抛错', () => {
  const ws = tmpWs();
  const pad = new FileScratchpad(() => ws);
  assert.strictEqual(pad.latest(), undefined, '无文件应回空态');

  mkdirSync(join(ws, '.omniharness'), { recursive: true });
  writeFileSync(join(ws, '.omniharness', 'scratchpad.json'), '{ 损坏的 json', 'utf8');
  assert.strictEqual(pad.latest(), undefined, '损坏文件应回空态');
  assert.deepStrictEqual(pad.recent(5), []);

  assert.strictEqual(pad.append('   '), undefined, '空正文应拒收');
  assert.strictEqual(pad.append('ok-but-disk-fails?')!.text, 'ok-but-disk-fails?');
  pad.clear();
  assert.strictEqual(pad.latest(), undefined, 'clear 后回空态');
  pad.clear(); // 幂等
  rmSync(ws, { recursive: true, force: true });
});
