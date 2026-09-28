/**
 * GIF 解码单测（真实文件，非合成构造）。
 *
 * ## 为什么用真实 GIF 而不是手写字节
 *
 * 手写一个 GIF 需要自己实现 LZW **编码**——那等于给解码器配一个"同源"的陪练：
 * 两边同时错（例如都把码长增长点算在同一个错误位置）时测试照样全绿。本夹具是
 * **本机 ffmpeg 编出来的真实 GIF**（8×8、256 色调色板、3 帧红/蓝/绿、`-loop 0`），
 * 其码流由第三方编码器生成，对解码器构成真正的外部判据。
 *
 * ## 断言取向：只信"外部可验证"的性质
 *
 * ① 结构：逻辑屏尺寸、帧数、时间轴单调递增；
 * ② 像素：每帧是**纯色**（ffmpeg 侧每帧都是单色块 ⇒ 解出来若五花八门必是 LZW/合成错），
 *    且三个帧的主色依次为红 / 蓝 / 绿（顺序错了说明帧序或时间轴错位）；
 * ③ 不变量：不透明（alpha 全 255）、无受损帧（`damagedFrameCount === 0`）。
 *
 * 不断言调色板的具体 RGB 值：ffmpeg 允许量化，`red` 可能落地为 `(253,0,0)`；
 * 断言"红分量显著占优"既稳健又足以发现真正的解码错误。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { GifDecoder } from '../../src/media/gifDecoder.js';
import { MediaSniffer } from '../../src/media/mediaSniffer.js';
import { GifFrameCompositor } from '../../src/media/gifFrameCompositor.js';
import { GifLzwDecoder } from '../../src/media/gifLzwDecoder.js';
import type { GifColorTableRef, GifDecodedFrame, GifImageSpec } from '../../src/media/gifTypes.js';

/**
 * 真实 GIF 夹具（本机 ffmpeg 生成，8×8、256 色全局调色板、3 帧红/蓝/绿、921 字节）：
 *
 * ```text
 * ffmpeg -f lavfi -i "color=c=red:s=8x8:r=10:d=0.1" \
 *        -f lavfi -i "color=c=blue:s=8x8:r=10:d=0.1" \
 *        -f lavfi -i "color=c=green:s=8x8:r=10:d=0.1" \
 *        -filter_complex "[0:v][1:v][2:v]concat=n=3:v=1[v];[v]split[a][b];\
 *          [a]palettegen=max_colors=8[p];[b][p]paletteuse=dither=none[out]" \
 *        -map "[out]" -fps_mode passthrough -loop 0 tiny5.gif
 * ```
 *
 * `-fps_mode passthrough` 不可省：默认模式下 concat 出的 3 帧会被丢成 2 帧
 * （实测 `dup=0 drop=2`），夹具帧数就不再是「已知真值」，断言随之失去意义。
 *
 * 该文件的结构真值（由独立手写解析器核对，未复用被测代码）：3 个图像描述符、均为
 * 8×8 全画布、非隔行、图形控制扩展延迟 10cs＝100ms；三帧像素主色依次为
 * 红 (253,0,0) / 蓝 (0,0,254) / 绿 (0,127,0)。
 */
const REAL_GIF_BASE64 =
  'R0lGODlhCAAIAPf/MQAA/gB/AP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAP0AAAD/ACH/C05FVFNDQVBFMi4wAwEAAAAh+QQFAQADACwAAAAACAAIAIEAAP4AfwD9AAAA/wAIDwAFCBxIsKDBgwgTKkwYEAAh+QQFAQD/ACwAAAAACAAIAAAIDwABCBxIsKDBgwgTKkwYEAAh+QQFCgD/ACwAAAAACAAIAAAIDwADCBxIsKDBgwgTKkwYEAA7';

/** 夹具字节。 */
const gifBytes = Buffer.from(REAL_GIF_BASE64, 'base64');

/**
 * 取某帧的像素（RGBA）。
 *
 * @param frame 解码帧。
 * @param x 横坐标。
 * @param y 纵坐标。
 * @returns `[r, g, b, a]`。
 */
const pixel = (frame: GifDecodedFrame, x: number, y: number): readonly number[] => {
  const offset = (y * frame.width + x) * 4;
  return [
    frame.rgba[offset] ?? -1,
    frame.rgba[offset + 1] ?? -1,
    frame.rgba[offset + 2] ?? -1,
    frame.rgba[offset + 3] ?? -1,
  ];
};

test('真实 GIF：嗅探为 animated gif，结构扫描得到 3 帧且时间轴单调递增', () => {
  const info = MediaSniffer.sniff(gifBytes, '.gif');
  assert.strictEqual(info.kind, 'gif');
  assert.strictEqual(info.container, 'gif');
  assert.strictEqual(info.width, 8);
  assert.strictEqual(info.height, 8);
  assert.strictEqual(info.animated, true, '多帧 GIF 必须被标为 animated');

  const anim = GifDecoder.decode(gifBytes, {});
  assert.strictEqual(anim.width, 8);
  assert.strictEqual(anim.height, 8);
  assert.strictEqual(anim.frames.length, 3, '三帧都必须解出');
  assert.strictEqual(anim.timeline.length, 3);
  assert.strictEqual(anim.damagedFrameCount, 0, '真实文件不得报受损');
  assert.strictEqual(anim.truncated, false);
  let previous = -1;
  for (const entry of anim.timeline) {
    assert.ok(entry.timestampMs > previous, `时间轴必须严格递增：${entry.timestampMs}`);
    previous = entry.timestampMs;
  }
  assert.strictEqual(anim.timeline[0]?.timestampMs, 0, '首帧恒在 0');
  assert.deepStrictEqual(
    anim.timeline.map((entry) => entry.sourceIndex),
    [0, 1, 2],
  );
});

test('真实 GIF：三帧都是纯色，且主色依次为红 / 蓝 / 绿（帧序与时间轴不得错位）', () => {
  const anim = GifDecoder.decode(gifBytes, {});
  const expected: ReadonlyArray<'red' | 'green' | 'blue'> = ['red', 'blue', 'green'];
  anim.frames.forEach((frame, index) => {
    const first = pixel(frame, 0, 0);
    for (let y = 0; y < frame.height; y += 1) {
      for (let x = 0; x < frame.width; x += 1) {
        assert.deepStrictEqual(
          pixel(frame, x, y),
          first,
          `第 ${index} 帧应为纯色，但 (${x},${y}) 与 (0,0) 不同 ⇒ LZW 解码或合成有误`,
        );
      }
    }
    assert.strictEqual(first[3], 255, '不透明（alpha 恒 255）');
    const [r, g, b] = first as [number, number, number, number];
    const want = expected[index];
    if (want === 'red') {
      assert.ok(r > g + 60 && r > b + 60, `第 ${index} 帧应为红色系，实际 ${first.join(',')}`);
    } else if (want === 'blue') {
      assert.ok(b > r + 60 && b > g + 60, `第 ${index} 帧应为蓝色系，实际 ${first.join(',')}`);
    } else {
      assert.ok(g > r + 60 && g > b + 60, `第 ${index} 帧应为绿色系，实际 ${first.join(',')}`);
    }
  });
});

test('真实 GIF：定向解码（wantedIndices + stopAfterIndex）与全量解码的同一帧逐字节一致', () => {
  const full = GifDecoder.decode(gifBytes, {});
  const selective = GifDecoder.decode(gifBytes, { wantedIndices: new Set([1]) });
  assert.strictEqual(selective.frames.length, 1, '只要第 1 帧');
  assert.deepStrictEqual(selective.frames[0]?.rgba, full.frames[1]?.rgba, '同一帧必须解出同样像素');
  assert.strictEqual(selective.frames[0]?.timestampMs, full.frames[1]?.timestampMs);

  const stopped = GifDecoder.decode(gifBytes, { stopAfterIndex: 1 });
  assert.strictEqual(
    stopped.truncated,
    true,
    '提前停止必须如实标记 truncated（结构统计不再是全量）',
  );
  assert.strictEqual(
    stopped.frames.length,
    2,
    '`stopAfterIndex: 1` 是「解到源帧 1（含）即停」⇒ 只交付源帧 0、1 两帧',
  );
  assert.strictEqual(stopped.frameCount, 2, '停止点之后的帧不得出现在结构统计里');
  assert.deepStrictEqual(
    stopped.timeline.map((entry) => entry.sourceIndex),
    [0, 1],
    '时间轴同样只到停止点为止',
  );
});

test('真实 GIF：任意截断点都不得抛未捕获异常，且必须如实标记扫描不完整', () => {
  // 头部（签名 6 + 逻辑屏 7 + 全局色表 768 = 781 字节）是整个文件里**唯一**允许响亮报错的区间：
  // 头部不完整意味着连坐标系与调色板都没有，此时产出任何像素都是编造（见下一个测试）。
  const headerEnd = 781;
  let checked = 0;
  for (let cut = headerEnd; cut < gifBytes.length; cut += 3) {
    const anim = GifDecoder.decode(gifBytes.subarray(0, cut), {});
    assert.ok(anim.frames.length <= 3, `截断到 ${cut} 字节不得凭空多出帧`);
    assert.strictEqual(
      anim.truncated,
      true,
      `截断到 ${cut} 字节未读到文件结束标记，必须如实标记 truncated`,
    );
    for (const frame of anim.frames) {
      assert.strictEqual(frame.rgba.length, 8 * 8 * 4, '已交付帧的画布尺寸必须正确');
      assert.strictEqual(frame.width, 8);
      assert.strictEqual(frame.height, 8);
    }
    checked += 1;
  }
  assert.ok(checked > 20, `截断点覆盖数不得退化（实际 ${String(checked)}）`);
});

test('GIF 头部不完整 / 不是 GIF：必须响亮报错，不得静默产出空动画', () => {
  assert.throws(
    () => GifDecoder.decode(Buffer.from('NOTAGIF!!', 'ascii'), {}),
    /不是 GIF 文件/,
    '签名不对必须报错（否则会把任意二进制当 GIF 解出垃圾像素）',
  );
  assert.throws(
    () => GifDecoder.decode(gifBytes.subarray(0, 5), {}),
    /截断/,
    '连签名都读不全必须报错',
  );
  assert.throws(
    () => GifDecoder.decode(gifBytes.subarray(0, 100), {}),
    /截断/,
    '全局颜色表未读完必须报错（无调色板却产出像素＝编造）',
  );
});

test('LZW 解码器：码流不完整时如实标记 complete:false（不抛错、不填假数据）', () => {
  // 只有「清空码 + 结束码」的合法但像素不足的码流（min code size 2 ⇒ 清空码 4、结束码 5）。
  // 码的位序 LSB 优先：码 4 = 100b ⇒ 位序 0,0,1；码 5 = 101b ⇒ 位序 1,0,1；
  // 故第 1 字节 = 1*4 + 1*8 + 1*32 = 0x2C（位 0..5 用满），第 2 字节空闲。
  // 期望 4 个像素却一个都没产出 ⇒ 必须如实报 `complete:false`。
  const result = GifLzwDecoder.decode(Buffer.from([0x2c, 0x00]), 2, 4);
  assert.strictEqual(result.complete, false, '像素数不足必须如实标记');
  assert.strictEqual(result.indices.length, 4, '输出长度恒等于期望像素数（尾部补 0，长度可依赖）');
  assert.deepStrictEqual([...result.indices], [0, 0, 0, 0]);
});

test('合成器：透明索引不覆盖画布、越界矩形被裁剪、disposal=2 清空画布、隔行按四遍重排', () => {
  /** 建立一个两色表：索引 0 = 红，1 = 蓝。 */
  const tableOf = (): GifColorTableRef => ({
    size: 2,
    writeRgba: (target: Uint8Array, offset: number, index: number): void => {
      const color = index === 0 ? [255, 0, 0, 255] : [0, 0, 255, 255];
      target[offset] = color[0] ?? 0;
      target[offset + 1] = color[1] ?? 0;
      target[offset + 2] = color[2] ?? 0;
      target[offset + 3] = color[3] ?? 255;
    },
  });
  /**
   * 造一份图像块描述（GIF 图形控制扩展的字段已合并进来）。
   *
   * @param overrides 覆盖字段。
   * @returns 图像块描述。
   */
  const spec = (overrides: Partial<GifImageSpec> = {}): GifImageSpec => ({
    left: 0,
    top: 0,
    width: 2,
    height: 2,
    interlaced: false,
    localColorTable: undefined,
    transparentIndex: undefined,
    disposal: 1,
    delayMs: 100,
    minCodeSize: 2,
    data: Buffer.alloc(0),
    ...overrides,
  });

  const compositor = new GifFrameCompositor(2, 2);
  compositor.draw(spec(), tableOf(), new Uint8Array([0, 0, 0, 0]));
  assert.deepStrictEqual([...compositor.snapshot().subarray(0, 4)], [255, 0, 0, 255]);

  // 透明索引 0 ⇒ 该像素"不画"，画布保留上一层（GIF 的透明是挖洞语义）。
  compositor.draw(
    spec({ width: 1, height: 1, transparentIndex: 0 }),
    tableOf(),
    new Uint8Array([0]),
  );
  assert.deepStrictEqual(
    [...compositor.snapshot().subarray(0, 4)],
    [255, 0, 0, 255],
    '透明索引处应保留底图',
  );

  // 越界矩形（5×5 落在 2×2 画布上）只画重叠部分，不越界写入、不抛错。
  compositor.draw(
    spec({ left: 1, top: 1, width: 5, height: 5 }),
    tableOf(),
    new Uint8Array(25).fill(1),
  );
  const bounded = compositor.snapshot();
  assert.strictEqual(bounded.length, 2 * 2 * 4, '画布尺寸不得被矩形撑大');
  assert.deepStrictEqual([...bounded.subarray(12, 16)], [0, 0, 255, 255], '重叠部分被写入');

  // disposal=2：清空为透明（本实现的取舍，见类注释）。
  compositor.applyDisposal(2);
  assert.deepStrictEqual([...compositor.snapshot()], new Array<number>(16).fill(0));

  // 隔行：高度 4 的帧按 GIF 规范的固定四遍（起始行/步长＝0/8、4/8、2/4、1/2）重排。
  // 「存储序 → 显示行」的映射推导（第 2 遍因起始行 4 已越界而空）：
  //   存储序 0 → 显示行 0（第 1 遍）；存储序 1 → 显示行 2（第 3 遍）；
  //   存储序 2 → 显示行 1（第 4 遍）；存储序 3 → 显示行 3（第 4 遍）。
  // 故存储色序 [红,蓝,红,蓝] 应落到显示行 [红,红,蓝,蓝]。
  const interlaced = new GifFrameCompositor(1, 4);
  interlaced.draw(
    spec({ width: 1, height: 4, interlaced: true }),
    tableOf(),
    new Uint8Array([0, 1, 0, 1]),
  );
  const rows = interlaced.snapshot();
  const rowColor = (y: number): string => ((rows[y * 4] ?? 0) === 255 ? 'red' : 'blue');
  assert.deepStrictEqual(
    [rowColor(0), rowColor(1), rowColor(2), rowColor(3)],
    ['red', 'red', 'blue', 'blue'],
    '隔行重排错位 ⇒ 逐帧画面对不上（这是「看起来能出图」但内容全错的典型）',
  );
});
