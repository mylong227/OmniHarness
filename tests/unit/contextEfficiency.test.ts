import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Canonical, PrefixStability, DeterministicCompressor } from '../../src/context/index.js';
import type { ContextSegment, PromptSegment } from '../../src/context/index.js';

// ---------- canonical ----------

test('canonicalize：幂等（canonicalize ∘ canonicalize ≡ canonicalize）', () => {
  const value = { b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } };
  const once = Canonical.canonicalize(value);
  assert.deepStrictEqual(Canonical.canonicalize(once), once);
});

test('canonicalize：对象 key 顺序无关（数组保序）', () => {
  const a = Canonical.canonicalize({ x: 1, y: [1, 2, 3] });
  const b = Canonical.canonicalize({ y: [1, 2, 3], x: 1 });
  assert.deepStrictEqual(a, b);
  // 数组顺序是语义，不得排序
  assert.notDeepStrictEqual(Canonical.canonicalize({ y: [3, 2, 1] }), a);
});

test('stableStringify：key 顺序不同仍产出同一字节串', () => {
  assert.strictEqual(
    Canonical.stableStringify({ a: 1, b: 2 }),
    Canonical.stableStringify({ b: 2, a: 1 }),
  );
  // 剔除 undefined 字段
  assert.strictEqual(
    Canonical.stableStringify({ a: 1, b: undefined }),
    Canonical.stableStringify({ a: 1 }),
  );
});

test('scrubVolatile：擦除时间戳 / UUID / pid', () => {
  const noisy = 'run at 2024-01-02T03:04:05.678Z id=0a1b2c3d-eeee-4aaa-8bbb-ccccddddeeee pid=4242';
  const cleaned = Canonical.scrubVolatile(noisy);
  assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(cleaned));
  assert.ok(!/pid=4242/.test(cleaned));
  assert.ok(cleaned.includes('<TS>'));
  assert.ok(cleaned.includes('<PID>'));
});

// ---------- prefix stability ----------

test('commonPrefixLength / prefixReuse：自反率为 1', () => {
  assert.strictEqual(PrefixStability.commonPrefixLength('abcdef', 'abcxyz'), 3);
  const text = 'hello world';
  assert.strictEqual(PrefixStability.prefixReuse(text, text), 1);
  // 空前缀视为完全可复用
  assert.strictEqual(PrefixStability.prefixReuse('', 'anything'), 1);
});

const BASE_SEGMENTS: readonly PromptSegment[] = [
  { key: 'system', tier: 0, text: 'You are OmniHarness.' },
  { key: 'tools', tier: 1, text: 'read_file(path)\nwrite_file(path, content)' },
  { key: 'history', tier: 2, text: 'user: 读取 a.ts\nassistant: 已读取' },
  { key: 'input', tier: 3, text: '请修改 a.ts 第 3 行' },
];

/** 朴素拼接：按输入顺序（竞品常见做法，无排序、无擦除）。 */
function naivePrompt(segments: readonly PromptSegment[]): string {
  return segments.map((s) => `\n## ${s.key}\n${s.text}`).join('');
}

test('前缀复用：规范化后 ≡ 1（顺序抖动 + 易变注入下仍完全复用）', () => {
  const report = PrefixStability.measurePrefixStability(BASE_SEGMENTS, 12, true);
  assert.strictEqual(report.minReuse, 1, '规范前缀在任何抖变体下都应 100% 可复用');
  assert.strictEqual(report.meanReuse, 1);
});

test('前缀复用：不规范化时显著劣化（证明治理必要，非装饰）', () => {
  const raw = PrefixStability.measurePrefixStability(BASE_SEGMENTS, 12, false);
  assert.ok(raw.meanReuse < 1, `未规范化复用率应 <1，实测 ${raw.meanReuse}`);
});

test('对照：朴素拼接在顺序抖动下复用率崩塌，规范拼接不受影响', () => {
  // 基准同样是抖变体（真实每轮都带噪声），否则是拿理想态比真实态
  const naiveBase = naivePrompt(PrefixStability.jitterSegments(BASE_SEGMENTS, 1));
  const stableBase = PrefixStability.buildStablePrompt(
    PrefixStability.jitterSegments(BASE_SEGMENTS, 1),
    { scrub: true },
  );
  let naiveSum = 0;
  let stableSum = 0;
  const n = 12;
  for (let i = 1; i <= n; i += 1) {
    const jittered = PrefixStability.jitterSegments(BASE_SEGMENTS, i);
    naiveSum += PrefixStability.prefixReuse(naiveBase, naivePrompt(jittered));
    stableSum += PrefixStability.prefixReuse(
      stableBase,
      PrefixStability.buildStablePrompt(jittered, { scrub: true }),
    );
  }
  const naiveMean = naiveSum / n;
  const stableMean = stableSum / n;
  assert.strictEqual(stableMean, 1);
  assert.ok(naiveMean < stableMean, `朴素 ${naiveMean} 应劣于规范 ${stableMean}`);
});

test('buildStablePrompt：按 (tier, key) 排序，与输入顺序无关', () => {
  const shuffled = [BASE_SEGMENTS[3]!, BASE_SEGMENTS[1]!, BASE_SEGMENTS[0]!, BASE_SEGMENTS[2]!];
  assert.strictEqual(
    PrefixStability.buildStablePrompt(shuffled),
    PrefixStability.buildStablePrompt(BASE_SEGMENTS),
  );
});

// ---------- deterministic compression ----------

const LONG_OUTPUT = (n: number): string =>
  Array.from({ length: n }, (_, i) => `line-${i}: some tool output payload`).join('\n');

function sampleSegments(): readonly ContextSegment[] {
  return [
    { key: 'system', kind: 'system', text: 'You are OmniHarness.\n\n\n' },
    {
      key: 'tool-1',
      kind: 'tool-result',
      text: JSON.stringify({ path: '/tmp/a.ts', lines: 120, ok: true }, null, 2),
    },
    { key: 'tool-2', kind: 'tool-result', text: LONG_OUTPUT(500) },
    { key: 'user-1', kind: 'user', text: '读取 a.ts' },
    { key: 'assistant-1', kind: 'assistant', text: '已读取，共 120 行。' },
    { key: 'user-2', kind: 'user', text: '读取 a.ts' }, // 与 user-1 完全重复
    { key: 'tool-3', kind: 'tool-result', text: LONG_OUTPUT(260) },
    { key: 'assistant-2', kind: 'assistant', text: '继续。' },
    { key: 'user-3', kind: 'user', text: '再确认一次' },
  ];
}

test('compressContext：单调性（压缩后字节 ≤ 压缩前）', () => {
  const { report } = DeterministicCompressor.compressContext(sampleSegments());
  assert.ok(report.compressedBytes <= report.originalBytes);
  assert.ok(report.ratio < 1, `应有实际压缩，实测 ratio=${report.ratio}`);
  assert.strictEqual(report.savedBytes, report.originalBytes - report.compressedBytes);
});

test('compressContext：幂等（compress ∘ compress ≡ compress）', () => {
  const once = DeterministicCompressor.compressContext(sampleSegments());
  const twice = DeterministicCompressor.compressContext(once.segments);
  assert.deepStrictEqual(twice.segments, once.segments);
  assert.strictEqual(twice.report.compressedBytes, once.report.compressedBytes);
});

test('compressContext：保序（去重保留首次出现，相对顺序不变）', () => {
  const input = sampleSegments();
  const { segments } = DeterministicCompressor.compressContext(input);
  const keys = segments.map((s) => s.key);
  // user-2 与 user-1 内容重复 → 被去除
  assert.ok(!keys.includes('user-2'));
  assert.ok(keys.includes('user-1'));
  // 其余顺序与输入一致
  const expected = input.map((s) => s.key).filter((k) => k !== 'user-2');
  assert.deepStrictEqual(keys, expected);
});

test('truncateLongOutput：幂等 + 保留可追溯行数（不制造幻觉）', () => {
  const long = LONG_OUTPUT(500);
  const once = DeterministicCompressor.truncateLongOutput(long, 200, 40, 40);
  assert.strictEqual(DeterministicCompressor.truncateLongOutput(once, 200, 40, 40), once);
  assert.ok(once.includes('[420 lines omitted of 500]'));
  // 短文本原样返回
  const short = 'a\nb';
  assert.strictEqual(DeterministicCompressor.truncateLongOutput(short, 200, 40, 40), short);
});

test('collapseBlankLines：幂等', () => {
  const messy = 'a   \n\n\n\nb\t\n';
  const once = DeterministicCompressor.collapseBlankLines(messy);
  assert.strictEqual(DeterministicCompressor.collapseBlankLines(once), once);
  assert.ok(!/\n{3,}/.test(once));
});

test('deduplicateSegments：幂等 + 保留首次', () => {
  const input: readonly ContextSegment[] = [
    { key: 'a', kind: 'user', text: 'same' },
    { key: 'b', kind: 'user', text: 'same' },
    { key: 'c', kind: 'user', text: 'other' },
  ];
  const once = DeterministicCompressor.deduplicateSegments(input);
  assert.deepStrictEqual(
    once.map((s) => s.key),
    ['a', 'c'],
  );
  assert.deepStrictEqual(DeterministicCompressor.deduplicateSegments(once), once);
});

test('byteLength：UTF-8 计（中文 3 字节，非 UTF-16）', () => {
  assert.strictEqual(DeterministicCompressor.byteLength('ab'), 2);
  assert.strictEqual(DeterministicCompressor.byteLength('中'), 3);
});
