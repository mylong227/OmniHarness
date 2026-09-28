import type {
  FrameExtractionRequest,
  FrameExtractionResult,
  MediaFrameExtractor,
} from '../../ports/media/frameExtractor.js';
import type { MediaKind } from '../../ports/media/mediaTypes.js';

/**
 * 帧提取路由：按媒体大类把请求分发给具备对应能力的实现。
 *
 * ## 为什么需要显式路由（而不是「让每个实现自己判断」）
 *
 * 每个提取器只声明自己支持什么（`supports`），路由负责**挑选与拒绝**：
 * - 命中**恰好一个** ⇒ 直接分发；
 * - 命中**零个** ⇒ 返回可行动的失败（静态图片该用 `view_image`；未知格式该报什么文件都不是）；
 * - 命中**多个** ⇒ 按注册顺序取第一个（顺序即优先级，写在组合根）。
 *
 * 把「没有提取器能处理」这类情形**在路由层**翻译成人话，而不是让工具层去猜
 * 「为什么没有帧」——「静止图片请用 view_image」这种提示只有在知道自己拿到的是什么
 * 类型时才说得出来。
 */
export class RoutingFrameExtractor implements MediaFrameExtractor {
  /** 实现名（诊断用）。 */
  public readonly name = 'media-router';

  /**
   * @param extractors 提取器列表（按优先级排序）。
   */
  public constructor(private readonly extractors: readonly MediaFrameExtractor[]) {}

  /**
   * 是否任一实现支持该大类（供工具层决定是否值得提示"不可用"）。
   *
   * @param kind 媒体大类。
   * @returns 有实现支持时为 true。
   */
  public supports(kind: MediaKind): boolean {
    return this.extractors.some((extractor) => extractor.supports(kind));
  }

  /**
   * 分发提取请求。
   *
   * @param request 提取请求。
   * @returns 提取结果；无实现支持时 `frames` 为空且 `notes` 给出可行动原因。
   */
  public async extract(request: FrameExtractionRequest): Promise<FrameExtractionResult> {
    const kind = request.probe.kind;
    const extractor = this.extractors.find((candidate) => candidate.supports(kind));
    if (extractor === undefined) {
      return {
        frames: [],
        probe: request.probe,
        notes: [RoutingFrameExtractor.explain(kind, request.probe.container)],
        truncated: false,
      };
    }
    return extractor.extract(request);
  }

  /**
   * 把「无人支持」翻译成可行动提示。
   *
   * 公开为静态方法：工具层在**提取失败**（如 ffmpeg 缺失、窗口非法）时也要把
   * 同一句「这是静态图片，请改用 view_image」带到错误信息里——两处各写一份文案
   * 必然漂移，而漂移的结果是模型在两处读到互相矛盾的指引。
   *
   * @param kind 媒体大类。
   * @param container 容器名（用于文案）。
   * @returns 提示文本。
   */
  public static explain(kind: MediaKind, container: string): string {
    if (kind === 'image') {
      return (
        `这是静态图片（${container}），不是动画/视频：请改用 view_image 读取 ` +
        '（它会把整幅图交给模型），本工具只负责「多帧序列」的抽帧与判读。'
      );
    }
    return (
      `无法识别的媒体格式（${container}）：本工具支持动画 GIF 与常见视频容器` +
      '（mp4/mov/webm/mkv/avi/ogg/mpegts/flv）。请确认文件确实是媒体文件，' +
      '或先用 ffmpeg 转成 mp4 再分析。'
    );
  }
}
