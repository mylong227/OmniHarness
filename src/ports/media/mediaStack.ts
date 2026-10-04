/**
 * 已装配的媒体抽帧栈（**端口契约**，G25-b/2026-10-03 从 `config/mediaStackAssembler.ts` 迁入）。
 *
 * 为什么类型要住在 ports：`SubagentPortSeed`（也是端口类型）持有它，而种子要同时喂给主会话工具集与
 * 子代工具集。类型若留在 `config/`，`configBuilder` / `configToolRegistry` 就得反向 import `configFactory`
 * ⇒ 形成配置子环（架构门禁 [5]）。类型是**契约**，契约住 ports 是六边形的第一原则。
 */

import type { MediaFrameExtractor } from './frameExtractor.js';
import type { ResolvedMediaOptions } from './resolvedMediaOptions.js';

/** 已装配的媒体抽帧栈（抽帧器 + 解析后的媒体选项）。 */
export interface MediaStack {
  /** 抽帧器（按格式路由；不可用时为不支持档，调用方据此如实降级）。 */
  readonly extractor: MediaFrameExtractor;
  /** 解析后的媒体选项（帧数 / 尺寸 / 超时等，已合并配置与环境变量）。 */
  readonly options: ResolvedMediaOptions;
}
