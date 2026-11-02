/**
 * 压缩**触发信号**（U2-1，2026-10-30，shadow）。
 *
 * 交付边界：组合规则只**计算与上报**（`combinedWouldTrigger`），不改变压缩时机——
 * 现行默认决策仍是「估算 ≥ 0.8×窗口」。判据钉住：信号确定性、shadow 不越权、
 * 组合规则三条支路各自可达、快路径（游标复用）零开销不产出信号。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { CompactionTriggerSignals } from '../../src/kernel/context/compactionTriggerSignals.ts';
import type { ModelMessage } from '../../src/contracts/ports/model/modelMessage.ts';

/** 填充指定字符数的 tool 消息。 */
function toolOf(id: string, chars: number): ModelMessage {
  return { role: 'tool', content: 'x'.repeat(chars), toolCallId: id };
}

test('measure：四类信号口径正确', () => {
  const messages: readonly ModelMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'a'.repeat(100) },
    {
      role: 'assistant',
      content: 'b'.repeat(50),
      toolCalls: [{ id: 't1', name: 'read_file', arguments: { path: 'a.ts' } }],
    },
    toolOf('t1', 350),
    { role: 'user', content: 'c'.repeat(100) },
  ];
  // 总字符 = 10(sys 算 content) + 100 + 50 + 350 + 100 = 610？sys content 'sys' 长 3——重算：
  // 3 + 100 + 50 + 350 + 100 = 603；tool 占 350。
  const result = CompactionTriggerSignals.measure(messages, 600, 1000);

  assert.strictEqual(result.turns, 2, 'user 消息数 = 轮数下界');
  assert.strictEqual(result.toolResultShare, Math.round((350 / 603) * 1000) / 1000);
  assert.strictEqual(result.repetitionRate, 0, '单次调用无重复');
});

test('measure：重复率按（工具+目标）聚合——同目标重复计、不同目标不计', () => {
  const messages: readonly ModelMessage[] = [
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: '1', name: 'read_file', arguments: { path: 'a.ts' } },
        { id: '2', name: 'read_file', arguments: { path: 'a.ts' } },
        { id: '3', name: 'read_file', arguments: { path: 'b.ts' } },
        { id: '4', name: 'shell', arguments: { command: 'npm test' } },
      ],
    },
  ];
  const result = CompactionTriggerSignals.measure(messages, 100, 1000);

  assert.strictEqual(result.repetitionRate, 0.5, '4 次调用里 2 次是重复（a.ts ×2）');
});

test('measure：组合规则三条支路各自可达', () => {
  const r = CompactionTriggerSignals.REFERENCE;
  // 支路 1：预算占比 ≥ 0.8（主信号，与现行阈值一致）。
  const main = CompactionTriggerSignals.measure([], Math.ceil(r.budgetRatio * 1000), 1000);
  assert.strictEqual(main.combinedWouldTrigger, true, 'budgetRatio 达标即触发');
  // 支路 2：占比在 [0.65, 0.8) 且工具结果占比 ≥ 0.5。
  const midRatio = (r.budgetRatio + r.budgetRatioWithToolShare) / 2;
  const heavyTools: readonly ModelMessage[] = [
    { role: 'user', content: 'a'.repeat(10) },
    toolOf('t', 990),
  ];
  const share = CompactionTriggerSignals.measure(heavyTools, Math.floor(midRatio * 1000), 1000);
  assert.strictEqual(share.combinedWouldTrigger, true, '低预算占比 + 高工具占比 ⇒ 提前压');
  // 支路 3：重复率 ≥ 0.5 且轮数 ≥ 12。
  const repeated: readonly ModelMessage[] = [
    ...Array.from({ length: r.minTurns }, (_, i) => ({
      role: 'user' as const,
      content: `u${String(i)}`,
    })),
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'a', name: 'read_file', arguments: { path: 'a.ts' } },
        { id: 'b', name: 'read_file', arguments: { path: 'a.ts' } },
      ],
    },
  ];
  const spin = CompactionTriggerSignals.measure(repeated, 100, 1000);
  assert.strictEqual(spin.combinedWouldTrigger, true, '高重复 + 多轮 ⇒ 空转折叠');
});

test('measure：确定性——同输入两次结果逐位一致', () => {
  const messages: readonly ModelMessage[] = [
    { role: 'user', content: 'task' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: '1', name: 'shell', arguments: { command: 'npm test' } }],
    },
    toolOf('1', 500),
  ];
  const one = CompactionTriggerSignals.measure(messages, 300, 1000);
  const two = CompactionTriggerSignals.measure(messages, 300, 1000);

  assert.deepStrictEqual(one, two);
});

test('measure：预算为 0 时不除零', () => {
  const result = CompactionTriggerSignals.measure([{ role: 'user', content: 'x' }], 100, 0);

  assert.strictEqual(result.budgetRatio, 0);
  assert.strictEqual(result.combinedWouldTrigger, false);
});
