/**
 * 帧预算与采样单测：单帧编码收敛（`FrameEncoder`）/ 总字节均匀裁剪（`MediaFrameBudget`）/
 * 等间隔采样（`MediaFrameSampler`）。
 *
 * 为什么这三条必须钉：它们是「把多帧塞进模型上下文」的**唯一闸门**。三条判据分别对应
 * 三种真实翻车形态——
 *  ① 单帧降不下来就交付 ⇒ 端点 400（单帧超上限）；
 *  ② 逐帧都达标但合计超标 ⇒ 请求体被撑爆（总额超限）；
 *  ③ 总超限时「丢尾部」⇒ 模型永远看不到结尾（而视频结尾往往正是结论所在）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameEncoder, MediaFrameBudget } from '../../src/media/frameEncoder.js';
import { MediaFrameSampler } from '../../src/media/mediaFrameSampler.js';
import type { MediaFrame } from '../../src/ports/media/mediaTypes.js';
import type { RasterImage } from '../../src/media/rasterTypes.js';

/**
 * 构造一张确定的可压缩栅格（棋盘格，边界多 ⇒ 过滤/压缩效果真实）。
 *
 * @param size 边长（像素）。
 * @returns 栅格图。
 */
const checker = (size: number): RasterImage => {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      const on = (x + y) % 2 === 0;
      data[offset] = on ? 255 : 0;
      data[offset + 1] = on ? 0 : 255;
      data[offset + 2] = 128;
      data[offset + 3] = 255;
    }
  }
  return { rgba: data, width: size, height: size };
};

/**
 * 构造一个帧（字节内容为占位，只关心长度与时间）。
 *
 * @param index 序号。
 * @param timestampMs 时间点（毫秒）。
 * @param byteLength 字节数。
 * @returns 帧。
 */
const frame = (index: number, timestampMs: number, byteLength: number): MediaFrame => ({
  index,
  timestampMs,
  width: 8,
  height: 8,
  durationMs: 100,
  mediaType: 'image/png',
  bytes: Buffer.alloc(byteLength, 7),
});

test('FrameEncoder：预算内的帧原样产出；超限时缩到预算内并如实标记 shrunk', () => {
  const encoder = new FrameEncoder(1024, 1_000_000);
  const plain = encoder.encode(checker(8));
  assert.strictEqual(plain.ok, true);
  assert.strictEqual(plain.width, 8);
  assert.strictEqual(plain.height, 8);
  assert.strictEqual(plain.shrunk, false, '未超限不应缩放');
  assert.ok((plain.bytes?.byteLength ?? 0) > 0);

  // 长边上限 4 ⇒ 必须缩到 4×4，且 `shrunk` 为真（模型据此知道"这帧是缩过的"）。
  const shrunk = new FrameEncoder(4, 1_000_000).encode(checker(16));
  assert.strictEqual(shrunk.ok, true);
  assert.strictEqual(shrunk.width, 4);
  assert.strictEqual(shrunk.height, 4);
  assert.strictEqual(shrunk.shrunk, true);
});

test('FrameEncoder：实在降不到预算内时如实失败（ok:false + 原因），绝不交付超限帧', () => {
  // 下限 96px、8 次收缩；给一个不可能达成的 1 字节上限 ⇒ 必须走到失败分支。
  const outcome = new FrameEncoder(256, 1).encode(checker(512));
  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.bytes, undefined);
  assert.ok((outcome.reason ?? '').length > 0, '失败必须带原因');
});

test('MediaFrameBudget：总额达标时不动；超限时**均匀**保留且在预算内', () => {
  const frames = Array.from({ length: 8 }, (_, i) => frame(i, i * 100, 1_000));

  const untouched = MediaFrameBudget.trim(frames, 1_000_000);
  assert.strictEqual(untouched.dropped, 0);
  assert.strictEqual(untouched.frames.length, 8);
  assert.deepStrictEqual(
    untouched.frames.map((f) => f.index),
    [0, 1, 2, 3, 4, 5, 6, 7],
    '未裁剪时序号不变',
  );

  const trimmed = MediaFrameBudget.trim(frames, 3_000);
  assert.ok(trimmed.dropped > 0, '超限必须丢弃');
  assert.ok(
    trimmed.frames.reduce((sum, f) => sum + f.bytes.byteLength, 0) <= 3_000,
    '裁剪后总额必须落在预算内',
  );
  const kept = trimmed.frames.map((f) => f.index);
  assert.deepStrictEqual(kept, [0, 1, 2], '等长帧下按比例均匀保留（不偏袒尾部）');
  assert.strictEqual(kept[kept.length - 1], 2, '序号重编前应保持原序');
  // 交付的 frame.index 必须连续重编（模型据此按时间升序读图）。
  assert.deepStrictEqual(
    trimmed.frames.map((f) => f.index),
    trimmed.frames.map((_, i) => i),
  );
  assert.strictEqual(trimmed.frames.length + trimmed.dropped, 8, '保留 + 丢弃 = 原总数');
});

test('MediaFrameSampler.uniform：窗口过滤 + 等间隔取帧 + 上限 1 时取中点', () => {
  const timeline = Array.from({ length: 10 }, (_, i) => ({
    sourceIndex: i,
    timestampMs: i * 100,
    delayMs: 100,
  }));

  assert.deepStrictEqual(
    MediaFrameSampler.uniform(timeline, 0, undefined, 4).map((c) => c.sourceIndex),
    [0, 3, 6, 9],
    '10 帧取 4 帧应覆盖首尾',
  );
  assert.deepStrictEqual(
    MediaFrameSampler.uniform(timeline, 0, 10, 20).map((c) => c.sourceIndex),
    [0],
    '窗口内不足上限时全部保留（不做无谓牺牲）',
  );
  assert.deepStrictEqual(
    MediaFrameSampler.uniform(timeline, 300, 600, 10).map((c) => c.sourceIndex),
    [3, 4, 5, 6],
    '窗口过滤按闭区间',
  );
  assert.deepStrictEqual(
    MediaFrameSampler.uniform(timeline, 0, undefined, 1).map((c) => c.sourceIndex),
    [4],
    '上限 1 时取中间帧（不除零、不总取第一帧）',
  );
  assert.deepStrictEqual(MediaFrameSampler.uniform([], 0, undefined, 4), []);
});

test('MediaFrameSampler.intervalSeconds：与帧数成反比且有下限', () => {
  assert.ok(MediaFrameSampler.intervalSeconds(0, 10_000, 10) > 0);
  assert.ok(
    MediaFrameSampler.intervalSeconds(0, 10_000, 5) >
      MediaFrameSampler.intervalSeconds(0, 10_000, 20),
    '帧数越少间隔越大',
  );
  assert.ok(
    MediaFrameSampler.intervalSeconds(0, 0, 1_000_000) > 0,
    '退化窗口不得算出 0（除零护栏）',
  );
});
