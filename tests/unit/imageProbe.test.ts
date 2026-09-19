/**
 * 图片头解析单测（P2-⑬，零依赖：手工构造最小文件头）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ImageProbe } from '../../src/util/imageProbe.js';

/** 构造最小 PNG 头（仅魔数 + IHDR 尺寸，不含真实像素）。 */
const pngBytes = (width: number, height: number): Buffer => {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
};

test('PNG：识别类型与尺寸', () => {
  const info = ImageProbe.probe(pngBytes(120, 45));
  assert.deepStrictEqual(info, { mediaType: 'image/png', width: 120, height: 45 });
});

test('GIF：识别类型与尺寸（LE 字节序）', () => {
  const buffer = Buffer.alloc(10);
  buffer.write('GIF89a', 0, 'ascii');
  buffer.writeUInt16LE(33, 6);
  buffer.writeUInt16LE(44, 8);
  assert.deepStrictEqual(ImageProbe.probe(buffer), {
    mediaType: 'image/gif',
    width: 33,
    height: 44,
  });
});

test('JPEG：扫到 SOF0 取尺寸', () => {
  const buffer = Buffer.alloc(20);
  buffer[0] = 0xff;
  buffer[1] = 0xd8;
  buffer[2] = 0xff;
  buffer[3] = 0xc0;
  buffer.writeUInt16BE(6, 4);
  buffer.writeUInt16BE(77, 7);
  buffer.writeUInt16BE(66, 9);
  const info = ImageProbe.probe(buffer);
  assert.strictEqual(info?.mediaType, 'image/jpeg');
  assert.strictEqual(info?.width, 66);
  assert.strictEqual(info?.height, 77);
});

test('WebP（VP8X）：识别 24 位尺寸（值-1 编码）', () => {
  const buffer = Buffer.alloc(32);
  buffer.write('RIFF', 0, 'ascii');
  buffer.write('WEBP', 8, 'ascii');
  buffer.write('VP8X', 12, 'ascii');
  buffer.writeUIntLE(99, 24, 3);
  buffer.writeUIntLE(49, 27, 3);
  assert.deepStrictEqual(ImageProbe.probe(buffer), {
    mediaType: 'image/webp',
    width: 100,
    height: 50,
  });
});

test('非图片内容返回 undefined；SVG 靠扩展名兜底', () => {
  assert.strictEqual(ImageProbe.probe(Buffer.from('plain text, not an image')), undefined);
  assert.deepStrictEqual(ImageProbe.probe(Buffer.from('<svg/>'), '.svg'), {
    mediaType: 'image/svg+xml',
    width: undefined,
    height: undefined,
  });
});
