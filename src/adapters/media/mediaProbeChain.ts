import type { MediaProbePort } from '../../ports/media/mediaProbe.js';
import type { MediaProbeInfo } from '../../ports/media/mediaTypes.js';

/**
 * 探测链：按顺序尝试多个探测实现，取**第一个能给出关键信息的**结果。
 *
 * ## 判据为什么是「时长」而不是「非空」
 *
 * ffprobe 与 ffmpeg-stderr 都可能给出**缺字段**的结果（容器认识但拿不到时长，
 * 例如损坏的文件尾、直播流）。若判据只是「返回了对象」，那么一个「有尺寸没时长」的
 * 结果会挡住后面本可给出时长的探测，最终表现为「时长未知」——而这恰好是均匀采样
 * 唯一离不开的字段。故本类显式区分：
 *
 * - **有用结果**：`durationMs` 有值 ⇒ 立即返回；
 * - **部分结果**：只有尺寸等次要字段 ⇒ 记下作为兜底，继续尝试后续探测；
 * - 全部失败 ⇒ 返回部分结果（若一个都没有则 `undefined`）。
 *
 * 这让「探测能力可组合」，也把「为什么退化」的原因留在调用方可见的元数据里，
 * 而不是藏在某个 `??` 里。
 */
export class MediaProbeChain implements MediaProbePort {
  /** 端口名（便于诊断是哪个链路给出的结果）。 */
  public readonly name = 'probe-chain';

  /**
   * @param probes 探测实现（按优先级排序）。
   */
  public constructor(private readonly probes: readonly MediaProbePort[]) {}

  /**
   * 依次探测，取第一个给出时长的结果。
   *
   * @param absolutePath 源文件绝对路径。
   * @param signal 会话取消信号（可选）。
   * @returns 元数据；全部失败时为 `undefined`。
   */
  public async probe(
    absolutePath: string,
    signal?: AbortSignal,
  ): Promise<MediaProbeInfo | undefined> {
    let partial: MediaProbeInfo | undefined;
    for (const probe of this.probes) {
      const result = await probe.probe(absolutePath, signal);
      if (result === undefined) {
        continue;
      }
      if (result.durationMs !== undefined) {
        return result;
      }
      partial ??= result;
    }
    return partial;
  }
}
