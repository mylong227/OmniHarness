/**
 * 循环守卫的**文件维度**失控检测（2026-09-26 审计 A5）。
 *
 * 缺陷现场：守卫原先只认「名 + 规范化参数」的**字节等价**签名。而 `edit` / `apply_patch` 的
 * 振荡（把 A 改成 B、又改回 A）只要有一个字节不同就完全不可见 —— 模型可以无限来回改同一个
 * 文件而守卫一声不响。本用例把两种新形态钉住：
 *  - `edit-oscillation`：同一文件的**内容指纹**在 ≥1 个中间形态之后重现；
 *  - `edit-thrash`：窗口内同一文件被反复重写超过阈值。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LoopGuard } from '../../src/core/loop/loopGuard.js';

/** 构造一次 edit 调用。 */
function edit(path: string, newString: string) {
  return { name: 'edit', arguments: { path, old_string: 'x', new_string: newString } };
}

test('A5：同文件 A→B→A 振荡必须被判为 edit-oscillation（旧实现永远看不见）', () => {
  const guard = new LoopGuard();
  assert.strictEqual(guard.observe({ toolCalls: [edit('a.ts', 'A')] }).kind, 'allow');
  assert.strictEqual(guard.observe({ toolCalls: [edit('a.ts', 'B')] }).kind, 'allow');
  const decision = guard.observe({ toolCalls: [edit('a.ts', 'A')] });
  assert.strictEqual(decision.kind, 'nudge');
  assert.strictEqual(
    decision.kind === 'nudge' ? decision.violation : '',
    'edit-oscillation',
    '改回先前形态应被判振荡',
  );
});

test('A5：单调推进（A→B→C）不得误报', () => {
  const guard = new LoopGuard();
  for (const s of ['A', 'B', 'C', 'D', 'E']) {
    const decision = guard.observe({ toolCalls: [edit('a.ts', s)] });
    assert.notStrictEqual(
      decision.kind === 'nudge' ? decision.violation : decision.kind,
      'edit-oscillation',
      `单调推进到 ${s} 被误判为振荡`,
    );
  }
});

test('A5：不同文件之间的交替不算同文件振荡', () => {
  const guard = new LoopGuard();
  const seq: [string, string][] = [
    ['a.ts', 'A'],
    ['b.ts', 'A'],
    ['a.ts', 'B'],
    ['b.ts', 'B'],
    ['a.ts', 'C'],
    ['b.ts', 'C'],
  ];
  for (const [file, content] of seq) {
    const decision = guard.observe({ toolCalls: [edit(file, content)] });
    assert.notStrictEqual(
      decision.kind === 'nudge' ? decision.violation : decision.kind,
      'edit-oscillation',
    );
  }
});

test('A5：同一文件反复重写超阈值 ⇒ edit-thrash', () => {
  const guard = new LoopGuard();
  let thrash = false;
  for (let i = 0; i < 12; i += 1) {
    const decision = guard.observe({ toolCalls: [edit('a.ts', `v${String(i)}`)] });
    if (decision.kind === 'nudge' && decision.violation === 'edit-thrash') {
      thrash = true;
      break;
    }
  }
  assert.strictEqual(thrash, true, '窗口内同文件写入过多应触发 edit-thrash');
});

test('A5：apply_patch 无 path 时从 +++ 头取目标（不得因此漏检）', () => {
  const guard = new LoopGuard();
  const patch = (body: string) =>
    ({
      name: 'apply_patch',
      arguments: {
        patch: ['--- a/a.ts', '+++ b/a.ts', '@@ -1,1 +1,1 @@', `-x`, `+${body}`].join('\n'),
      },
    }) as const;
  guard.observe({ toolCalls: [patch('A')] });
  guard.observe({ toolCalls: [patch('B')] });
  const decision = guard.observe({ toolCalls: [patch('A')] });
  assert.strictEqual(decision.kind, 'nudge');
  assert.strictEqual(decision.kind === 'nudge' ? decision.violation : '', 'edit-oscillation');
});
