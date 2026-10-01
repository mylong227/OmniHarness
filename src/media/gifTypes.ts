/**
 * GIF 解码领域的共享词汇（纯类型，无逻辑）。
 *
 * 这些类型描述的是**GIF 规范里的结构**（块、图形控制扩展、处置方式），
 * 而不是 OmniHarness 的对外契约——对外契约在 `ports/media/**`。
 * 分层的理由：GIF 的处置方式/隔行/透明索引是实现细节，不应泄漏到工具与模型侧。
 */

/**
 * 处置方式（GIF 图形控制扩展的 disposal method，0–3）。
 *
 * - `0` 未指定（按 `1` 处理）
 * - `1` 保留画布（下一帧叠加其上）
 * - `2` 还原为背景（本实现＝清空为透明）
 * - `3` 还原为上一帧绘制前的状态
 */
import type { GifDecodedFrame } from '../ports/media/gifDecodedFrame.js';

export type GifDisposalMethod = 0 | 1 | 2 | 3;

/**
 * 一帧图像块的完整描述（图形控制扩展的值已合并进来——GIF 语义上它作用于**下一个**图像块）。
 */
export interface GifImageSpec {
  /** 相对逻辑屏的左边距。 */
  readonly left: number;
  /** 相对逻辑屏的上边距。 */
  readonly top: number;
  /** 图像宽度。 */
  readonly width: number;
  /** 图像高度。 */
  readonly height: number;
  /** 是否隔行存储（须按 4 遍重排为逐行）。 */
  readonly interlaced: boolean;
  /** 局部颜色表（缺省时用全局表）。 */
  readonly localColorTable: GifColorTableRef | undefined;
  /** 透明色索引（`undefined`＝无透明）。 */
  readonly transparentIndex: number | undefined;
  /** 生效的处置方式。 */
  readonly disposal: GifDisposalMethod;
  /** 帧延迟（毫秒，已按浏览器语义归一化）。 */
  readonly delayMs: number;
  /** LZW 最小码长（图像数据首字节）。 */
  readonly minCodeSize: number;
  /** 已拼接的图像数据子块（仍为 LZW 压缩态）。 */
  readonly data: Buffer;
}

/** 颜色表引用（`GifColorTable` 的最小只读面，避免类型循环）。 */
export interface GifColorTableRef {
  /** 颜色数。 */
  readonly size: number;
  /**
   * 把某个调色板索引写成 RGBA 四字节。
   *
   * @param target 目标像素缓冲（RGBA）。
   * @param offset 写入起点（字节偏移）。
   * @param index 调色板索引。
   * @returns 无返回值。
   */
  writeRgba(target: Uint8Array, offset: number, index: number): void;
}

export type { GifDecodedFrame } from '../ports/media/gifDecodedFrame.js';

export type { GifFrameTiming } from '../ports/media/gifFrameTiming.js';

export type { GifAnimation } from '../ports/media/gifAnimation.js';

/** LZW 解码结果。 */
export interface GifLzwResult {
  /** 调色板索引（长度恒等于期望像素数；码流提前结束时尾部为 0）。 */
  readonly indices: Uint8Array;
  /** 码流是否**完整**（读到结束码且恰好填满期望像素数）——不完整必须由调用方如实上报。 */
  readonly complete: boolean;
}

/** 解码选项。 */
export interface GifDecodeOptions {
  /**
   * 只保留这些源帧序号（`undefined`＝全保留）。
   *
   * 注意：**画布状态依赖全部前序帧**（处置方式会累积），故前序帧仍会被逐帧解码与合成，
   * 只是不做像素快照，省下的是内存与编码成本，而不是 CPU。
   */
  readonly wantedIndices?: ReadonlySet<number> | undefined;
  /**
   * 每解出一帧即回调（流式模式）。
   *
   * 与 `wantedIndices` 可同时使用：回调拿到的是**每一帧**，保留的只是被选中的那些。
   * 场景采样靠它把选择逻辑放在解码过程中（内存上界由回调方自己控制），
   * 从而避免「先全解出来再挑」的内存炸弹。
   */
  readonly onFrame?: ((frame: GifDecodedFrame) => void) | undefined;
  /** 解到该源帧序号（含）即停止——用于「只要前 N 帧」时避免把整部长动画解完。 */
  readonly stopAfterIndex?: number | undefined;
  /** 只扫结构与时长，不解码 LZW、不合成像素（探测快路径）。 */
  readonly skipPixels?: boolean | undefined;
  /** 结构扫描的帧数硬上限（防止病态/恶意文件把内存吃满）；超限即 `truncated`。 */
  readonly maxFrames?: number | undefined;
}
