/**
 * `FrameSceneSelector` 真判据：钉死「阈值 72」「首帧必留」「minGap 收窄」「超限抽稀」四件事。
 *
 * ## 为什么这些断言不是恒真
 *
 * 每条临界断言都配一条**显式复现错误实现**的对照行（错误实现写在判据内部，不改被测源码）：
 * 同一份输入在两条判据下结论**相反**，才说明临界值真的被钉住了。列举：
 *
 * | 判据 | 正确实现 | 错误实现 | 对照行 |
 * | --- | --- | --- | --- |
 * | 单像素差阈值 | `delta > 72` | `delta >= 72` | 「恰好 72 不算变化」 |
 * | 帧变化比例阈值 | `fraction < t` 丢弃 | `fraction <= t` 丢弃 | 「恰好等于阈值仍保留」 |
 * | 最小间隔 | `gap < minGap` 丢弃 | `gap <= minGap` 丢弃 | 「恰好等于 minGap 仍保留」 |
 * | 超限抽稀 | 保留偶数位 + minGap 翻倍 | 不翻倍 | 「抽稀后 minGap 必须翻倍」 |
 * | 相邻比较基准 | 每帧都更新 `previous` | 只在保留时更新 | 「被丢弃的帧仍要当下一帧的比较基准」 |
 *
 * 全部输入都是**自己造的 Buffer**，不依赖任何外部工具或真实媒体文件。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameSceneSelector } from '../../src/media/frameSceneSelector.js';
import type { SceneSelectedFrame } from '../../src/media/frameSceneSelector.js';
import type { GifDecodedFrame } from '../../src/ports/media/gifDecodedFrame.js';

/** 单个像素的 RGB 三元组（alpha 恒 255，本判据不使用）。 */
type Rgb = readonly [number, number, number];

/**
 * 按像素序列造 RGBA 缓冲。
 *
 * @param pixels 每个像素的 RGB。
 * @returns 长度 = `pixels.length × 4` 的 RGBA 字节。
 */
const rgbaOf = (pixels: readonly Rgb[]): Uint8Array => {
  const out = new Uint8Array(pixels.length * 4);
  for (let index = 0; index < pixels.length; index += 1) {
    const pixel = pixels[index];
    if (pixel === undefined) {
      continue;
    }
    out[index * 4] = pixel[0];
    out[index * 4 + 1] = pixel[1];
    out[index * 4 + 2] = pixel[2];
    out[index * 4 + 3] = 255;
  }
  return out;
};

/**
 * 按像素序列造一帧。
 *
 * @param pixels 每个像素的 RGB。
 * @param timestampMs 起始时间（毫秒）。
 * @param sourceIndex 源帧序号（缺省 0）。
 * @returns 一帧解码结果。
 */
const frameOf = (
  pixels: readonly Rgb[],
  timestampMs: number,
  sourceIndex = 0,
): GifDecodedFrame => ({
  rgba: rgbaOf(pixels),
  width: pixels.length,
  height: 1,
  delayMs: 100,
  timestampMs,
  sourceIndex,
});

/** 1 像素全黑。 */
const BLACK_1 = rgbaOf([[0, 0, 0]]);
/** 1 像素：三通道差之和恰好 71（23+24+24）。 */
const DELTA_71 = rgbaOf([[23, 24, 24]]);
/** 1 像素：三通道差之和恰好 72（24+24+24）——阈值本身。 */
const DELTA_72 = rgbaOf([[24, 24, 24]]);
/** 1 像素：三通道差之和恰好 73（24+24+25）——刚越过阈值。 */
const DELTA_73 = rgbaOf([[24, 24, 25]]);

/** 4 像素全黑。 */
const BLACK_4: readonly Rgb[] = [
  [0, 0, 0],
  [0, 0, 0],
  [0, 0, 0],
  [0, 0, 0],
];
/** 4 像素全白。 */
const WHITE_4: readonly Rgb[] = [
  [255, 255, 255],
  [255, 255, 255],
  [255, 255, 255],
  [255, 255, 255],
];
/** 4 像素：只有第 1 个变了（变化比例恰好 0.25）。 */
const MIXED_1_OF_4: readonly Rgb[] = [
  [255, 255, 255],
  [0, 0, 0],
  [0, 0, 0],
  [0, 0, 0],
];

/**
 * 三通道差之和（判据内部复算，用来把「临界值确实是 72」写成可读证据而非注释）。
 *
 * @param previous 前一像素字节（至少 3 字节）。
 * @param current 当前像素字节（至少 3 字节）。
 * @returns `|ΔR| + |ΔG| + |ΔB|`。
 */
const deltaOf = (previous: Uint8Array, current: Uint8Array): number =>
  Math.abs((previous[0] ?? 0) - (current[0] ?? 0)) +
  Math.abs((previous[1] ?? 0) - (current[1] ?? 0)) +
  Math.abs((previous[2] ?? 0) - (current[2] ?? 0));

test('单像素阈值：71/72 不算变化，73 才算——临界点在 72 与 73 之间', () => {
  // 先把「输入确实落在临界点上」写成断言，避免临界判据因夹具写反而恒绿。
  assert.strictEqual(deltaOf(BLACK_1, DELTA_71), 71, '夹具：差值应为 71');
  assert.strictEqual(deltaOf(BLACK_1, DELTA_72), 72, '夹具：差值应为 72（阈值本身）');
  assert.strictEqual(deltaOf(BLACK_1, DELTA_73), 73, '夹具：差值应为 73');

  assert.strictEqual(
    FrameSceneSelector.changedFraction(BLACK_1, DELTA_71),
    0,
    '71 < 72 ⇒ 不算变化',
  );
  assert.strictEqual(
    FrameSceneSelector.changedFraction(BLACK_1, DELTA_72),
    0,
    '恰好 72 不算变化（判据是严格大于）',
  );
  assert.strictEqual(FrameSceneSelector.changedFraction(BLACK_1, DELTA_73), 1, '73 > 72 ⇒ 算变化');

  // 正对照：同一份 72 的输入，若判据写成 `>=` 就会翻成「变化」——上面的 0 因此不是恒真。
  const wrongVerdictOf = (delta: number): boolean => delta >= 72;
  assert.strictEqual(
    wrongVerdictOf(deltaOf(BLACK_1, DELTA_72)),
    true,
    '错误实现（>=）会把 72 判成变化',
  );
  assert.strictEqual(wrongVerdictOf(deltaOf(BLACK_1, DELTA_73)), true, '错误实现在 73 上也判变化');
  assert.notStrictEqual(
    FrameSceneSelector.changedFraction(BLACK_1, DELTA_72) > 0,
    wrongVerdictOf(deltaOf(BLACK_1, DELTA_72)),
    '正确实现与错误实现在 72 上结论必须相反',
  );
});

test('全黑 vs 全白：每像素差 765 ⇒ 全帧变化；同帧自比恒为 0', () => {
  const black = rgbaOf(BLACK_4);
  const white = rgbaOf(WHITE_4);

  assert.strictEqual(deltaOf(black, white), 765, '夹具：黑白单像素差应为 3 × 255');
  assert.strictEqual(FrameSceneSelector.changedFraction(black, white), 1, '全黑→全白：变化比例 1');
  assert.strictEqual(FrameSceneSelector.changedFraction(white, black), 1, '全白→全黑：变化比例 1');
  assert.strictEqual(FrameSceneSelector.changedFraction(black, black), 0, '同帧自比：0');
  assert.strictEqual(FrameSceneSelector.changedFraction(white, white), 0, '同帧自比（白）：0');
});

test('变化比例是「占比」而非「计数」：4 像素中 1 个变 ⇒ 恰好 0.25', () => {
  const fraction = FrameSceneSelector.changedFraction(rgbaOf(BLACK_4), rgbaOf(MIXED_1_OF_4));
  assert.strictEqual(
    fraction,
    0.25,
    '1/4 必须是 0.25；若返回 1 说明它数的是「有变化」而不是「占比」',
  );
});

test('尺寸不一致：按较小长度比较（如实钉住现状，不做「必须相等」的臆断）', () => {
  const short = rgbaOf(BLACK_4.slice(0, 2)); // 2 像素
  const longSamePrefix = rgbaOf([...BLACK_4.slice(0, 2), [255, 255, 255], [255, 255, 255]]);

  assert.strictEqual(short.length, 8, '夹具：短帧 2 像素');
  assert.strictEqual(longSamePrefix.length, 16, '夹具：长帧 4 像素');
  assert.strictEqual(
    FrameSceneSelector.changedFraction(short, longSamePrefix),
    0,
    '只比较较小长度的前缀：多出来的像素被忽略',
  );
  assert.strictEqual(
    FrameSceneSelector.changedFraction(longSamePrefix, short),
    0,
    '反向传入同样按较小长度比较（顺序不影响口径）',
  );
  // 前缀确有差异时照常报出来（否则上面的 0 可能只是「一律返回 0」）。
  assert.strictEqual(
    FrameSceneSelector.changedFraction(short, rgbaOf(WHITE_4)),
    1,
    '前缀不同时必须报出变化，证明上面的 0 不是「一律 0」',
  );
});

test('不足一个像素（含空缓冲）：返回 0 而不是 NaN', () => {
  const empty = new Uint8Array(0);
  const threeBytes = Uint8Array.from([0, 0, 0]);
  const threeBytesWhite = Uint8Array.from([255, 255, 255]);

  assert.strictEqual(FrameSceneSelector.changedFraction(empty, empty), 0, '空缓冲 ⇒ 0');
  const partial = FrameSceneSelector.changedFraction(threeBytes, threeBytesWhite);
  assert.strictEqual(partial, 0, '不足 4 字节 ⇒ 0（没有完整像素可判）');
  assert.ok(Number.isFinite(partial), '不得返回 NaN（0/0 的实现会在这里露馅）');
});

test('首帧无条件保留：即使它与「全黑参照」完全相同，也不会被阈值挡掉', () => {
  const allBlack = frameOf(BLACK_4, 0, 0);
  // 若把首帧误实现为「与全零缓冲比较」，全黑首帧的变化比例会是 0 而不是 1。
  assert.strictEqual(
    FrameSceneSelector.changedFraction(rgbaOf(BLACK_4), rgbaOf(BLACK_4)),
    0,
    '夹具：全黑与自己比确实是 0（所以首帧若走比较路径就会被丢）',
  );

  const selector = new FrameSceneSelector({ threshold: 1, maxFrames: 4, minGapMs: 0 });
  // 用 length 而不是 deepStrictEqual(…, [])：后者带 `asserts actual is never[]`，
  // 会把后续的 `selected[0]` 收窄成 never，判据就再也读不到字段了。
  assert.strictEqual(selector.selected.length, 0, '还没送帧时不应有选中帧（帧数不足的基线）');
  selector.consider(allBlack);
  assert.strictEqual(selector.selected.length, 1, 'threshold=1 下首帧仍必须保留');
  assert.strictEqual(selector.selected[0]?.sourceIndex, 0, '保留首帧的 sourceIndex');
  assert.strictEqual(selector.selected[0]?.width, 4, '保留宽度');
  assert.strictEqual(selector.selected[0]?.height, 1, '保留高度');
  assert.strictEqual(selector.selected[0]?.delayMs, 100, '保留时长');
  assert.strictEqual(selector.selected[0]?.timestampMs, 0, '保留时间戳');
  assert.deepStrictEqual(
    [...(selector.selected[0]?.rgba ?? [])],
    [...allBlack.rgba],
    '保留像素与输入逐字节一致',
  );

  // 第二帧完全相同 ⇒ 变化比例 0 < 1 ⇒ 丢弃（证明上面那条保留不是「一律保留」）。
  selector.consider(frameOf(BLACK_4, 1000, 1));
  assert.strictEqual(selector.selected.length, 1, '帧相同则第二帧被丢弃');
});

test('比例阈值是「严格小于才丢」：恰好等于阈值仍保留', () => {
  const keptAtBoundary = new FrameSceneSelector({ threshold: 0.25, maxFrames: 4, minGapMs: 0 });
  keptAtBoundary.consider(frameOf(BLACK_4, 0, 0));
  keptAtBoundary.consider(frameOf(MIXED_1_OF_4, 10, 1));
  assert.deepStrictEqual(
    keptAtBoundary.selected.map((f) => f.sourceIndex),
    [0, 1],
    'fraction = 0.25 = threshold ⇒ 保留',
  );

  const droppedAbove = new FrameSceneSelector({ threshold: 0.26, maxFrames: 4, minGapMs: 0 });
  droppedAbove.consider(frameOf(BLACK_4, 0, 0));
  droppedAbove.consider(frameOf(MIXED_1_OF_4, 10, 1));
  assert.deepStrictEqual(
    droppedAbove.selected.map((f) => f.sourceIndex),
    [0],
    'fraction = 0.25 < 0.26 ⇒ 丢弃',
  );

  // 正对照：错误实现（`fraction <= threshold` 即丢）会把恰好等于阈值的那帧丢掉。
  const wrongKeeps = (fraction: number, threshold: number): boolean => fraction > threshold;
  assert.strictEqual(wrongKeeps(0.25, 0.25), false, '错误实现在边界上会丢帧——正确实现必须与之相反');
  assert.strictEqual(keptAtBoundary.selected.length, 2, '正确实现在边界上保留');
});

test('最小间隔：间隔 < minGap 丢帧，恰好等于 minGap 保留', () => {
  const selector = new FrameSceneSelector({ threshold: 0.5, maxFrames: 8, minGapMs: 100 });
  selector.consider(frameOf(BLACK_4, 0, 0)); // 首帧必留
  selector.consider(frameOf(WHITE_4, 50, 1)); // 变化足够，但间隔 50 < 100 ⇒ 丢
  selector.consider(frameOf(BLACK_4, 100, 2)); // 间隔 100 = 100 ⇒ 留
  selector.consider(frameOf(WHITE_4, 199, 3)); // 间隔 99 < 100 ⇒ 丢

  assert.deepStrictEqual(
    selector.selected.map((f) => f.sourceIndex),
    [0, 2],
    '被保留的应当恰好是间隔达标的 0 与 2',
  );

  // 正对照：错误实现（`gap <= minGap` 即丢）会把间隔恰好等于 100 的第 2 帧一起丢掉。
  const wrongDrops = (gap: number, minGap: number): boolean => gap <= minGap;
  assert.strictEqual(wrongDrops(100, 100), true, '错误实现在 gap=100 时会丢帧');
  assert.ok(
    selector.selected.some((f) => f.sourceIndex === 2),
    '正确实现必须留着它（与错误实现结论相反）',
  );
});

test('被丢弃的帧仍要成为下一帧的比较基准（否则比较会停留在旧帧上）', () => {
  const selector = new FrameSceneSelector({ threshold: 0.5, maxFrames: 8, minGapMs: 1000 });
  selector.consider(frameOf(BLACK_4, 0, 0)); // 首帧留 ⇒ previous = 黑
  selector.consider(frameOf(WHITE_4, 10, 1)); // 变化 1，但间隔 10 < 1000 ⇒ 丢；previous 应变白
  selector.consider(frameOf(WHITE_4, 2000, 2)); // 与白相同 ⇒ 变化 0 ⇒ 丢

  assert.deepStrictEqual(
    selector.selected.map((f) => f.sourceIndex),
    [0],
    '只有首帧被保留：第 2 帧与白帧相同，说明基准已更新到「被丢弃的白帧」',
  );

  // 反面对照（错误实现的完整推演）：若基准只在保留时更新，第 3 帧会与黑帧比出 1 而被保留。
  const wrongBaselineStillBlack = FrameSceneSelector.changedFraction(
    rgbaOf(BLACK_4),
    rgbaOf(WHITE_4),
  );
  assert.strictEqual(wrongBaselineStillBlack, 1, '错误实现下第 3 帧会算出 1 并进入保留列表');
  assert.strictEqual(selector.selected.length, 1, '正确实现下它不在保留列表里');
});

test('超限抽稀：保留偶数位并把 minGap 翻倍（覆盖整条时间轴，不偏袒开头）', () => {
  const selector = new FrameSceneSelector({ threshold: 0.5, maxFrames: 2, minGapMs: 10 });
  selector.consider(frameOf(BLACK_4, 0, 0));
  selector.consider(frameOf(WHITE_4, 20, 1));
  selector.consider(frameOf(BLACK_4, 40, 2)); // 超限 ⇒ 抽稀成 [0, 2]，minGap 10 ⇒ 20
  assert.deepStrictEqual(
    selector.selected.map((f) => f.sourceIndex),
    [0, 2],
    '抽稀保留偶数位（不是「先到先得」的 [0, 1]）',
  );
  assert.ok(selector.selected.length <= 2, '抽稀后不得超过 maxFrames');

  selector.consider(frameOf(WHITE_4, 55, 3)); // 间隔 15 < 新的 20 ⇒ 丢（证明 minGap 确实翻倍了）
  assert.deepStrictEqual(
    selector.selected.map((f) => f.sourceIndex),
    [0, 2],
    'minGap 翻倍为 20 后，间隔 15 的帧被丢弃',
  );

  // 正对照：若 minGap 没翻倍（仍是 10），间隔 15 的帧就会被保留 —— 结论与上一条相反。
  const wrongKeepsFrame3 = 15 >= 10;
  assert.strictEqual(wrongKeepsFrame3, true, '错误实现（未翻倍）会保留第 3 帧');

  selector.consider(frameOf(BLACK_4, 60, 4)); // 间隔 20 = 新的 20 ⇒ 留 ⇒ 再抽稀成 [0, 4]，minGap ⇒ 40
  assert.deepStrictEqual(
    selector.selected.map((f) => f.sourceIndex),
    [0, 4],
    '再次超限时继续抽稀（保留原有偶数位中的偶数位）',
  );

  selector.consider(frameOf(WHITE_4, 90, 5)); // 间隔 30 < 40 ⇒ 丢
  assert.deepStrictEqual(
    selector.selected.map((f) => f.sourceIndex),
    [0, 4],
    'minGap 已翻倍到 40：间隔 30 的帧被丢弃',
  );
  selector.consider(frameOf(BLACK_4, 100, 6)); // 间隔 40 = 40 ⇒ 留 ⇒ 抽稀成 [0, 6]
  assert.deepStrictEqual(
    selector.selected.map((f) => f.sourceIndex),
    [0, 6],
    '抽稀后帧仍均匀铺满时间轴（末帧始终是最新的达标帧）',
  );
  // 反面对照：「先到先得」型的实现在这里只会剩 [0, 1]，永远看不到时间轴后半段。
  assert.notDeepStrictEqual(
    selector.selected.map((f) => f.sourceIndex),
    [0, 1],
    '不得退化成「取前 N 个」',
  );
});

test('确定性：同一串输入两次运行结果逐字段相同', () => {
  const run = (): readonly SceneSelectedFrame[] => {
    const selector = new FrameSceneSelector({ threshold: 0.25, maxFrames: 2, minGapMs: 10 });
    const inputs: readonly GifDecodedFrame[] = [
      frameOf(BLACK_4, 0, 0),
      frameOf(MIXED_1_OF_4, 20, 1),
      frameOf(WHITE_4, 40, 2),
      frameOf(BLACK_4, 61, 3),
      frameOf(MIXED_1_OF_4, 80, 4),
    ];
    for (const input of inputs) {
      selector.consider(input);
    }
    return selector.selected;
  };

  const first = run();
  const second = run();
  assert.deepStrictEqual(second, first, '同输入同输出（无时间/随机依赖）');
  assert.ok(first.length > 0, '判据必须建立在非空结果上，否则「相等」无意义');

  // 逐步喂入的中间态也必须确定（不是只有终态可比）。
  const stepwise = new FrameSceneSelector({ threshold: 0.25, maxFrames: 2, minGapMs: 10 });
  const snapshotsA: string[] = [];
  for (const input of [frameOf(BLACK_4, 0, 0), frameOf(WHITE_4, 20, 1), frameOf(BLACK_4, 40, 2)]) {
    stepwise.consider(input);
    snapshotsA.push(stepwise.selected.map((f) => f.sourceIndex).join(','));
  }
  assert.deepStrictEqual(snapshotsA, ['0', '0,1', '0,2'], '每一步的中间态都应与推演一致');
});
