/** 采样候选帧（源序号 + 时间轴位置）。 */
export interface FrameCandidate {
  /** 源中的帧序号（GIF 为块序号；视频由外部工具按顺序编号，此处不使用）。 */
  readonly sourceIndex: number;
  /** 该帧起始时间（毫秒）。 */
  readonly timestampMs: number;
  /** 该帧显示时长（毫秒）；未知为 `undefined`。 */
  readonly delayMs: number | undefined;
}

/**
 * 抽帧采样器：决定「从时间轴上取哪几帧」。
 *
 * ## 均匀采样为什么是默认
 *
 * 均匀（等时间间隔）采样对模型最友好：帧与帧之间的时间关系是**稳定**的，
 * 模型可以直接从 `t=0.0 / 1.5 / 3.0 …` 推断「两帧之间发生了什么、变化有多快」。
 * 而按「关键帧 / 随机 / 首尾各半」这类策略取到的帧，时间间隔不规律，
 * 模型会系统性地误判节奏（把 0.1 秒的瞬变说成「逐渐变化」）。
 *
 * ## 为什么不用「按时长直接算下标」
 *
 * GIF 的帧时长**不均匀**（每帧有自己的延迟），故采样必须建立在**时间轴**上而不是帧下标上：
 * 先按延迟累加出每帧的起始时间，再在时间轴上等距取点。
 * 本类只做纯计算（不碰像素、不碰 IO），因此采样策略可以被逐点单测钉住。
 */
export class MediaFrameSampler {
  /** 采样间隔下限（毫秒）：防止 `maxFrames` 极大时把间隔算成 0 而退化成「全取」。 */
  private static readonly MIN_INTERVAL_MS = 1;

  /**
   * 按时间轴均匀选取帧。
   *
   * @param candidates 候选帧（须按 `timestampMs` 升序；乱序会导致取点错位）。
   * @param startMs 采样窗口起点（毫秒，含）。
   * @param endMs 采样窗口终点（毫秒，含）；`undefined`＝到时间轴末尾。
   * @param maxFrames 最多取多少帧（≥1）。
   * @returns 选中的帧（升序）；窗口内无帧时为空数组。
   */
  public static uniform(
    candidates: readonly FrameCandidate[],
    startMs: number,
    endMs: number | undefined,
    maxFrames: number,
  ): FrameCandidate[] {
    const inWindow = MediaFrameSampler.window(candidates, startMs, endMs);
    if (inWindow.length === 0 || maxFrames < 1) {
      return [];
    }
    if (inWindow.length <= maxFrames) {
      // 候选不超过上限：全部保留，不做「为了整齐而丢帧」的无谓牺牲。
      return [...inWindow];
    }
    const last = inWindow.length - 1;
    if (maxFrames === 1) {
      // 只取一帧时取**中间**：首帧往往是黑场/片头，中间帧对整体内容的代表性最好。
      return [inWindow[Math.floor(last / 2)] as FrameCandidate];
    }
    const step = last / (maxFrames - 1);
    const picked: FrameCandidate[] = [];
    for (let index = 0; index < maxFrames; index += 1) {
      const target = Math.round(index * step);
      const candidate = inWindow[target] ?? (inWindow[last] as FrameCandidate);
      picked.push(candidate);
    }
    return picked;
  }

  /**
   * 截取采样窗口内的候选。
   *
   * @param candidates 候选帧（升序）。
   * @param startMs 窗口起点（毫秒，含）。
   * @param endMs 窗口终点（毫秒，含）；`undefined`＝到末尾。
   * @returns 窗口内的候选（保持原顺序）。
   */
  public static window(
    candidates: readonly FrameCandidate[],
    startMs: number,
    endMs: number | undefined,
  ): FrameCandidate[] {
    const upper = endMs ?? Number.POSITIVE_INFINITY;
    return candidates.filter(
      (candidate) => candidate.timestampMs >= startMs && candidate.timestampMs <= upper,
    );
  }

  /**
   * 计算时间轴上的均匀采样间隔（秒）——供把「取 N 帧」翻译成外部工具表达式的场景使用。
   *
   * @param startMs 窗口起点（毫秒）。
   * @param endMs 窗口终点（毫秒）。
   * @param maxFrames 期望帧数（≥1）。
   * @returns 采样间隔（秒，至少 0.001）。
   */
  public static intervalSeconds(startMs: number, endMs: number, maxFrames: number): number {
    const windowMs = Math.max(1, endMs - startMs);
    const intervalMs = Math.max(
      MediaFrameSampler.MIN_INTERVAL_MS,
      windowMs / Math.max(1, maxFrames),
    );
    return intervalMs / 1000;
  }
}
