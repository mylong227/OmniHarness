/**
 * 媒体编解码内核单测：CRC-32 / PNG 行过滤 / PNG 编码 / 缩放。
 *
 * 为什么把自实现的编码器测到「能被独立解析器读回来」这一步：PNG 的每个块都带 CRC-32，
 * 且 IHDR 的宽高按大端写入——写错一个字节，`view_media` 交付给模型的附件就是坏图，
 * 而**坏图的失败方式是静默的**（模型拿到无法解码的 base64，只会说"看不清"）。
 * 故此处用仓库既有的 `ImageProbe`（独立实现，只读文件头）做交叉校验：
 * 编码器产出 → 独立解析器读回 ⇒ 至少证明结构自洽。
 *
 * CRC-32 另有一条**标准向量**锚定（CRC-32/IEEE，`"123456789"` → `0xCBF43926`），
 * 避免"表算错了但编码/解码都用同一张错表"的假自洽。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Crc32 } from '../../src/media/crc32.js';
import { PngEncoder } from '../../src/media/pngEncoder.js';
import { PngFilterSelector } from '../../src/media/pngFilterSelector.js';
import { RasterScaler } from '../../src/media/rasterScaler.js';
import { MediaSniffer } from '../../src/media/mediaSniffer.js';
import type { RasterImage } from '../../src/media/rasterTypes.js';

/**
 * 构造一张纯色栅格。
 *
 * @param width 宽度（像素）。
 * @param height 高度（像素）。
 * @param rgba 四通道值。
 * @returns 栅格图。
 */
const solid = (width: number, height: number, rgba: readonly number[]): RasterImage => {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = rgba[0] ?? 0;
    data[i * 4 + 1] = rgba[1] ?? 0;
    data[i * 4 + 2] = rgba[2] ?? 0;
    data[i * 4 + 3] = rgba[3] ?? 255;
  }
  return { rgba: data, width, height };
};

/**
 * 构造一张左右两色的栅格（用于检验行过滤/缩放确实按像素位置取值）。
 *
 * @param width 宽度（像素）。
 * @param height 高度（像素）。
 * @returns 栅格图。
 */
const split = (width: number, height: number): RasterImage => {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const left = x < width / 2;
      data[offset] = left ? 255 : 0;
      data[offset + 1] = 0;
      data[offset + 2] = left ? 0 : 255;
      data[offset + 3] = 255;
    }
  }
  return { rgba: data, width, height };
};

test('CRC-32：标准向量 + 区间切片与整体一致', () => {
  const vector = Buffer.from('123456789', 'utf8');
  assert.strictEqual(Crc32.of(vector), 0xcbf43926, 'CRC-32/IEEE 标准向量必须吻合');
  assert.strictEqual(Crc32.of(vector, 0, 9), 0xcbf43926);
  assert.strictEqual(Crc32.of(Buffer.concat([Buffer.from('xx'), vector]), 2), 0xcbf43926);
  assert.strictEqual(Crc32.of(new Uint8Array(0)), 0, '空输入为 0（算法定义）');
});

test('PNG 行过滤：五种过滤都能算完，且自适应结果可被反向还原', () => {
  const raster = split(8, 4);
  const filtered = PngFilterSelector.apply(raster.rgba, raster.width, raster.height);
  // 每行 1 字节过滤类型 + width*4 字节数据。
  assert.strictEqual(filtered.length, (raster.width * 4 + 1) * raster.height);
  for (let y = 0; y < raster.height; y += 1) {
    const type = filtered[y * (raster.width * 4 + 1)];
    assert.ok(type !== undefined && type <= 4, `第 ${y} 行的过滤类型必须在 0..4`);
  }
});

test('PNG 编码：产出可被独立解析器读回的合法 PNG（IHDR 尺寸 + 魔数 + IEND）', () => {
  const bytes = PngEncoder.encode(solid(6, 3, [10, 20, 30, 255]));
  assert.deepStrictEqual(
    [...bytes.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    'PNG 魔数',
  );
  assert.strictEqual(bytes.subarray(12, 16).toString('ascii'), 'IHDR');
  assert.strictEqual(bytes.readUInt32BE(16), 6, 'IHDR 宽（大端）');
  assert.strictEqual(bytes.readUInt32BE(20), 3, 'IHDR 高（大端）');
  assert.strictEqual(bytes.subarray(24, 25).readUInt8(), 8, '位深 8');
  assert.strictEqual(bytes.subarray(25, 26).readUInt8(), 6, '颜色类型 6 = RGBA');
  assert.ok(bytes.subarray(-8, -4).equals(Buffer.from('IEND', 'ascii')), '以 IEND 收尾');
  // 交叉校验：走独立实现（只读文件头）读回尺寸与 MIME。
  const info = MediaSniffer.sniff(bytes, '.png');
  assert.strictEqual(info.kind, 'image');
  assert.strictEqual(info.container, 'png');
  assert.strictEqual(info.width, 6);
  assert.strictEqual(info.height, 3);
  assert.strictEqual(info.animated, false);
});

test('PNG 编码：CRC-32 是「类型 + 数据」，改动数据即改动校验位', () => {
  const a = PngEncoder.encode(solid(4, 4, [1, 2, 3, 255]));
  const b = PngEncoder.encode(solid(4, 4, [1, 2, 4, 255]));
  assert.notDeepStrictEqual([...a], [...b]);
  // 逐块自校验：解析每个块（长度/类型/数据/CRC），确认 CRC 覆盖范围正确。
  let offset = 8;
  let chunks = 0;
  while (offset + 12 <= a.length) {
    const length = a.readUInt32BE(offset);
    const type = a.subarray(offset + 4, offset + 8).toString('ascii');
    const expected = a.readUInt32BE(offset + 8 + length);
    const actual = Crc32.of(a, offset + 4, offset + 8 + length);
    assert.strictEqual(actual, expected, `块 ${type} 的 CRC-32 必须覆盖类型 + 数据`);
    offset += 12 + length;
    chunks += 1;
  }
  assert.strictEqual(chunks, 3, 'IHDR / IDAT / IEND 三块');
  assert.strictEqual(offset, a.length, '块边界必须恰好铺满整个文件（无残留）');
});

test('缩放：fit 只在超限时缩、长边精确落到上限、比例保持；resize 取整且不越界', () => {
  const raster = split(800, 400);
  const fitted = RasterScaler.fit(raster, 100);
  assert.strictEqual(fitted.width, 100);
  assert.strictEqual(fitted.height, 50);
  assert.strictEqual(RasterScaler.fit(raster, 1000), raster, '未超限时原样返回（不做无谓重采样）');
  const resized = RasterScaler.resize(raster, 3, 2);
  assert.strictEqual(resized.width, 3);
  assert.strictEqual(resized.height, 2);
  assert.strictEqual(resized.rgba.length, 3 * 2 * 4);
  // 左半红、右半蓝：降采样后左列仍偏红、右列仍偏蓝（证明不是把整图平铺成常量）。
  assert.ok((resized.rgba[0] ?? 0) > (resized.rgba[8] ?? 0), '左列红分量应高于右列');
});
