import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  compressContext,
  truncateLongOutput,
  collapseBlankLines,
  minifyJsonBlock,
  deduplicateSegments,
  foldHistorySegments,
  byteLength,
  type ContextSegment,
  type CompressOptions,
} from '../../src/context/deterministicCompressor.js';

function seg(
  kind: ContextSegment['kind'],
  text: string,
  key = `k-${Math.random()}`,
): ContextSegment {
  return { key, kind, text };
}

const sampleSegments = (): ContextSegment[] => [
  seg('system', 'You are a helpful assistant.\n\n\n'),
  seg('user', 'What is the meaning of life?\n\n'),
  seg('assistant', 'The meaning of life is 42.'),
  seg('user', 'Repeat that.'),
  seg('assistant', 'The meaning of life is 42.'),
  seg('tool-result', '{"a":   1,  "b":   2}'),
];

describe('确定性上下文压缩', () => {
  it('定律一：单调（压缩后字节 ≤ 压缩前）', () => {
    const { report } = compressContext(sampleSegments());
    assert.ok(report.compressedBytes <= report.originalBytes);
    assert.strictEqual(report.savedBytes, report.originalBytes - report.compressedBytes);
  });

  it('定律二：幂等（compress ∘ compress ≡ compress）', () => {
    const once = compressContext(sampleSegments());
    const twice = compressContext(once.segments);
    assert.strictEqual(twice.report.compressedBytes, once.report.compressedBytes);
    assert.strictEqual(twice.segments.length, once.segments.length);
  });

  it('定律三：保序（去重保留首次出现，相对顺序不变）', () => {
    const input = [
      seg('user', 'A'),
      seg('assistant', 'B'),
      seg('user', 'A'), // 重复
      seg('assistant', 'C'),
    ];
    const { segments } = compressContext(input);
    assert.deepStrictEqual(
      segments.map((s) => s.text),
      ['A', 'B', 'C'],
    );
  });

  it('truncateLongOutput：幂等 + 保留可追溯行数（不制造幻觉）', () => {
    const long = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const once = truncateLongOutput(long, 200, 40, 40);
    assert.strictEqual(truncateLongOutput(once, 200, 40, 40), once);
    assert.match(once, /\[420 lines omitted of 500\]/);
    const short = 'short\ntext';
    assert.strictEqual(truncateLongOutput(short, 200, 40, 40), short);
  });

  it('minifyJsonBlock：合法 JSON 紧凑 / 非 JSON 原样', () => {
    assert.strictEqual(minifyJsonBlock('{\n  "a": 1,\n  "b": 2\n}'), '{"a":1,"b":2}');
    assert.strictEqual(minifyJsonBlock('just text'), 'just text');
  });

  it('collapseBlankLines：折叠多余空行与行尾空白', () => {
    assert.strictEqual(collapseBlankLines('a  \n\n\n\nb'), 'a\n\nb');
  });

  it('deduplicateSegments：跨 kind 不误去重、同 content 去重', () => {
    const input = [seg('user', 'X'), seg('assistant', 'X'), seg('user', 'X')];
    const out = deduplicateSegments(input);
    // user/X 出现两次但 assistant/X 不同指纹 → 保留 2 条
    assert.strictEqual(out.length, 2);
  });

  it('foldHistorySegments：第 foldAfter 轮后对话折叠为单行', () => {
    const input = [
      seg('user', 'one'),
      seg('assistant', 'two'),
      seg('user', 'three'),
      seg('assistant', 'four'),
    ];
    const out = foldHistorySegments(input, 1);
    assert.strictEqual(out[2]!.kind, 'history');
    assert.match(out[2]!.text, /\[folded #3\]/);
  });

  it('byteLength：等于 UTF-8 字节数', () => {
    assert.strictEqual(byteLength('ascii'), 5);
    assert.strictEqual(byteLength('中文'), 6);
  });

  it('可配置选项生效（关闭 dedupe / 调整阈值）', () => {
    const opts: CompressOptions = { dedupe: false, maxLines: 1000, foldAfter: 100 };
    const { segments, report } = compressContext(sampleSegments(), opts);
    // 关闭 dedupe → 重复 assistant 文本保留
    assert.strictEqual(segments.filter((s) => s.text === 'The meaning of life is 42.').length, 2);
    assert.ok(report.ratio > 0 && report.ratio <= 1);
  });
});
