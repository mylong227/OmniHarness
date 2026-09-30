import type { MediaKind } from './mediaKind.js';

/** 媒体元数据（`probe` 的产物）。 */
export interface MediaProbeInfo {
  /** 媒体大类。 */
  readonly kind: MediaKind;
  /** 容器 / 格式标识（如 `gif` / `mp4` / `webm`）。 */
  readonly container: string;
  /** 视频编码（如 `h264`）；未知为 `undefined`。 */
  readonly codec: string | undefined;
  /** 宽度（像素）；未知为 `undefined`。 */
  readonly width: number | undefined;
  /** 高度（像素）；未知为 `undefined`。 */
  readonly height: number | undefined;
  /** 总时长（毫秒）；静态图或未知为 `undefined`。 */
  readonly durationMs: number | undefined;
  /** 总帧数；未知为 `undefined`。 */
  readonly frameCount: number | undefined;
  /** 平均帧率（帧/秒）；未知为 `undefined`。 */
  readonly frameRate: number | undefined;
  /** 是否为多帧（动画 GIF / 视频为 true，静态图为 false）。 */
  readonly animated: boolean;
}
