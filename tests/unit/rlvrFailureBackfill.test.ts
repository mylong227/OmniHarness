/**
 * E3+（提案回填）判据：历史失败原因**真的进了采样 prompt**，且回填确实改变候选质量。
 *
 * ## 判据要钉死的四件事
 *
 * 1. **空即原文**：无原因（缺省 / 空数组 / 全空白）⇒ 采样 prompt **逐字节等于**原 prompt
 *    ——绝不留下只有标题的空段（空段既误导模型，又会让"回填占比"统计失真）；
 * 2. **有回填即出现**：原因非空 ⇒ prompt 含 {@link RlvrLoop.FAILURE_HINT_HEADER} 与**每一条**原因；
 * 3. **有界**：只回填最近 5 条，单条超 200 字符截断（超长失败堆栈不得撑爆 prompt）；
 * 4. **回填改变候选**（机制级对照，确定性桩采样器）：桩采样器**按 prompt 是否含回填段**产出不同代码，
 *    可验证奖励只认"修好的"代码 ⇒ 有回填的绿样本数 > 0、无回填 == 0。
 *
 * **诚实边界**：第 4 条是**机制级**对照（桩采样器 + 确定性奖励），证明的是"回填段贯通了
 * prompt→采样→奖励→回放"这条链路；**不是**真实模型的接受率提升（那需要真实模型与真实失败集）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RlvrLoop } from '../../src/evolution/rlvrLoop.js';
import { InMemoryReplayBuffer } from '../../src/evolution/inMemoryReplayBuffer.js';
import type { CodeCandidate, RlvrSampleContext } from '../../src/evolution/rlvrLoop.js';

test('E3+ 口径①：无回填 ⇒ 采样 prompt 与原 prompt 逐字节相同（不得留空段）', () => {
  const prompt = '实现一个失败重试装饰器';
  assert.strictEqual(RlvrLoop.composePrompt(prompt), prompt, '缺省不得改动 prompt');
  assert.strictEqual(RlvrLoop.composePrompt(prompt, []), prompt, '空数组不得改动 prompt');
  assert.strictEqual(RlvrLoop.composePrompt(prompt, ['', '   ']), prompt, '全空白原因不得拼段');
  assert.ok(!RlvrLoop.composePrompt(prompt, []).includes(RlvrLoop.FAILURE_HINT_HEADER));
});

test('E3+ 口径②：有回填 ⇒ prompt 含固定标题段与每一条原因（顺序保持）', () => {
  const composed = RlvrLoop.composePrompt('原任务', ['第一次：缺超时', '第二次：未处理异常']);
  assert.ok(composed.startsWith('原任务\n\n'), '原 prompt 必须在最前（模型先看到任务）');
  assert.ok(composed.includes(RlvrLoop.FAILURE_HINT_HEADER), '必须含回填段标题');
  assert.ok(
    composed.indexOf('第一次：缺超时') < composed.indexOf('第二次：未处理异常'),
    '顺序保持',
  );
  assert.ok(composed.includes('- 第一次：缺超时'), '每条原因以 `- ` 列表项呈现');
});

test('E3+ 口径③：有界——只回填最近 5 条，单条超 200 字符截断', () => {
  const reasons = Array.from({ length: 9 }, (_, i) => `reason-${String(i)}`);
  const composed = RlvrLoop.composePrompt('t', reasons);
  assert.ok(!composed.includes('reason-0'), '最早的 4 条必须被裁掉（只留最近 5 条）');
  for (const kept of ['reason-4', 'reason-5', 'reason-6', 'reason-7', 'reason-8']) {
    assert.ok(composed.includes(kept), `${kept} 必须被回填`);
  }
  const long = 'x'.repeat(500);
  const truncated = RlvrLoop.composePrompt('t', [long]);
  assert.ok(!truncated.includes('x'.repeat(201)), '单条原因必须截断到 200 字符以内');
  assert.ok(truncated.includes(`${'x'.repeat(200)}…`), '截断处必须有省略号（读者知道被截了）');
});

test('E3+ 口径④：回填贯通 prompt→采样→奖励→回放（机制级确定性对照）', async () => {
  const required = 'retry(3)';
  /** 桩采样器：**按 prompt 是否含回填段**产出不同代码（确定性、可复现）。 */
  const sampler = {
    seen: [] as string[],
    sample(prompt: string, index: number): CodeCandidate {
      this.seen.push(prompt);
      const healed = prompt.includes(RlvrLoop.FAILURE_HINT_HEADER);
      return { id: `s${String(index)}`, code: healed ? `fixed: ${required}` : 'attempt: naive' };
    },
  };
  /** 可验证奖励：只认"修好的"代码。 */
  const reward = (candidate: CodeCandidate): Promise<number> =>
    Promise.resolve(candidate.code.includes(required) ? 1 : 0);

  // 无回填：候选全是 naive ⇒ 绿样本 0。
  const without = await new RlvrLoop({
    sampler,
    reward,
    buffer: new InMemoryReplayBuffer(),
    samplesPerPrompt: 3,
  }).run('写一个带重试的请求函数');
  assert.strictEqual(without.kept, 0, '无回填 ⇒ 无绿样本（这是对照臂）');

  // 有回填：桩采样器看到回填段 ⇒ 产出 repaired 代码 ⇒ 绿样本 > 0。
  const seenBeforeHints = sampler.seen.length;
  const buffer = new InMemoryReplayBuffer();
  const withHints = await new RlvrLoop({
    sampler,
    reward,
    buffer,
    samplesPerPrompt: 3,
  }).run('写一个带重试的请求函数', { failureReasons: [`上次失败：没用 ${required}`] });
  assert.ok(withHints.kept > 0, '有回填 ⇒ 必须有绿样本（否则回填没有生效）');
  assert.strictEqual(withHints.kept, 3);
  assert.strictEqual(buffer.size, 3, '绿样本必须进回放缓冲');
  assert.strictEqual(withHints.best?.reward, 1);
  // 采样器**确实**收到了带回填段的 prompt（而不是循环内部自娱自乐）。
  assert.ok(
    sampler.seen.slice(seenBeforeHints).every((p) => p.includes(RlvrLoop.FAILURE_HINT_HEADER)),
    '采样器收到的必须是拼好回填段的 prompt（只看回填臂）',
  );
});

test('E3+ 上下文透传：reasons 通过 context 进入、source 不受影响（分桶口径不破）', async () => {
  let observed: RlvrSampleContext | undefined;
  const loop = new RlvrLoop({
    sampler: {
      sample: (prompt: string, index: number, context?: RlvrSampleContext) => {
        observed = context;
        return { id: `s${String(index)}`, code: prompt };
      },
    },
    reward: () => Promise.resolve(1),
    buffer: new InMemoryReplayBuffer(),
    samplesPerPrompt: 1,
  });
  await loop.run('t', { source: 'twist:a+b', failureReasons: ['r1'] });
  assert.strictEqual(observed?.source, 'twist:a+b', 'source 必须原样透传（分桶口径依赖它）');
  assert.deepStrictEqual(observed?.failureReasons, ['r1']);
});
