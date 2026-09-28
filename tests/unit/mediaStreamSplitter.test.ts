/**
 * 图片流切分单测：从 ffmpeg `image2pipe` 的**连续字节流**里切出一帧一帧的图片。
 *
 * 为什么这件事值得单测：`-f image2pipe -vcodec mjpeg` 把 N 帧图片首尾相接吐到一个 stdout，
 * 没有分隔、没有长度前缀。切错一帧，后面所有帧全部错位——而错位的表现是
 * 「模型看到一堆花屏」，不是报错。JPEG 段结构里最短的那条路（`SOS` 之后的熵编码数据）
 * 还专门有两种必须跳过的样本：`FF00`（字节填充）与 `FFD0–FFD7`（重启标记）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ImageStreamSplitter } from '../../src/media/imageStreamSplitter.js';
import { PngEncoder } from '../../src/media/pngEncoder.js';
import { MediaSniffer } from '../../src/media/mediaSniffer.js';
import type { RasterImage } from '../../src/media/rasterTypes.js';

/**
 * 构造纯色栅格。
 *
 * @param size 边长（像素）。
 * @param value 灰度值。
 * @returns 栅格图。
 */
const square = (size: number, value: number): RasterImage => {
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    data[i * 4] = value;
    data[i * 4 + 1] = value;
    data[i * 4 + 2] = value;
    data[i * 4 + 3] = 255;
  }
  return { rgba: data, width: size, height: size };
};

/**
 * 构造一个最小 JPEG：SOI + APP0 + SOF0 + SOS + 熵数据 + EOI。
 *
 * @param entropy 熵编码数据段（用于注入 `FF00` / `FFD0` 这类必须跳过的字节对）。
 * @returns JPEG 字节。
 */
const minimalJpeg = (entropy: readonly number[]): Buffer => {
  const parts: number[] = [
    0xff,
    0xd8, // SOI
    0xff,
    0xe0,
    0x00,
    0x10,
    0x4a,
    0x46,
    0x49,
    0x46,
    0x00,
    0x01,
    0x01,
    0x00,
    0x00,
    0x01,
    0x00,
    0x01,
    0x00,
    0x00, // APP0
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    0x00,
    0x08,
    0x00,
    0x08,
    0x01,
    0x01,
    0x11,
    0x00, // SOF0 (8x8)
    0xff,
    0xda,
    0x00,
    0x08,
    0x01,
    0x01,
    0x00,
    0x00,
    0x3f,
    0x00, // SOS
    ...entropy,
    0xff,
    0xd9, // EOI
  ];
  return Buffer.from(parts);
};

test('PNG 流：按块长走到 IEND，逐帧切出且顺序不失真', () => {
  const a = PngEncoder.encode(square(4, 10));
  const b = PngEncoder.encode(square(4, 200));
  const stream = Buffer.concat([a, b]);
  const frames = ImageStreamSplitter.split(stream, 'png');
  assert.strictEqual(frames.length, 2);
  assert.deepStrictEqual(frames[0], a);
  assert.deepStrictEqual(frames[1], b);
  assert.strictEqual(MediaSniffer.sniff(frames[1] ?? Buffer.alloc(0), '.png').kind, 'image');
});

test('PNG 流：尾部不完整的帧被丢弃（不交付半张图）', () => {
  const a = PngEncoder.encode(square(4, 10));
  const b = PngEncoder.encode(square(4, 200));
  const frames = ImageStreamSplitter.split(Buffer.concat([a, b.subarray(0, b.length - 6)]), 'png');
  assert.strictEqual(frames.length, 1, '只有完整帧才算一帧');
  assert.deepStrictEqual(frames[0], a);
});

test('JPEG 流：按段结构跳过熵数据切帧（含 FF00 填充与 FFD0 重启标记）', () => {
  const first = minimalJpeg([0x11, 0xff, 0x00, 0x22, 0xff, 0xd0, 0x33]);
  const second = minimalJpeg([0x44, 0xff, 0xd7, 0x55, 0xff, 0x00]);
  const frames = ImageStreamSplitter.split(Buffer.concat([first, second]), 'jpeg');
  assert.strictEqual(frames.length, 2, 'FF00 / FFD0–FFD7 不得被误判为段边界');
  assert.deepStrictEqual(frames[0], first);
  assert.deepStrictEqual(frames[1], second);
});

test('JPEG 流：空流与无 EOI 的残片都返回空数组（不猜、不硬切）', () => {
  assert.deepStrictEqual(ImageStreamSplitter.split(Buffer.alloc(0), 'jpeg'), []);
  const truncated = minimalJpeg([0x01, 0x02]).subarray(0, 12);
  assert.deepStrictEqual(ImageStreamSplitter.split(truncated, 'jpeg'), []);
});
