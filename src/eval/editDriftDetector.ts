/**
 * 反漂移检测（T4.2 · H2 · Harness Engineering）。
 *
 * 解决的问题：「循环编辑」——agent 在同一文件/同一区域反复修改（A→B→A→B 振荡，
 * 或同一文件被高频重写）却无净进展。这是 agent 失控最常见的前兆：不检测就会烧完
 * 预算才发现原地打转。检测器只依赖**编辑事件流**（文件 + 内容指纹），机械可判。
 *
 * 两类告警：
 * - **振荡 oscillation**：某文件的内容指纹在消去中间态后重现（A…B…A）——典型回退循环；
 * - **高频重写 thrash**：滑动窗口内同一文件的编辑次数超阈值—— grinder 式空转。
 *
 * 确定性：纯事件流推导，无随机源；同事件序列恒同告警。
 */
/** 一次编辑事件。 */
export interface EditEvent {
  /** 相对文件路径。 */
  readonly file: string;
  /** 内容指纹（如哈希/版本号；内容不变视为未编辑，调用方过滤）。 */
  readonly revision: string;
}

/** 漂移告警。 */
export interface DriftAlarm {
  /** 告警类型：oscillation = 内容指纹回退循环；thrash = 窗口内高频重写。 */
  readonly kind: 'oscillation' | 'thrash';
  /** 触发告警的文件。 */
  readonly file: string;
  /** 人类可读的判定依据（含关键计数/指纹序列）。 */
  readonly detail: string;
}

/** 检测器选项（全部有保守默认）。 */
export interface DriftDetectorOptions {
  /** 滑动窗口大小（最近 N 次编辑内统计；默认 20）。 */
  readonly windowSize?: number;
  /** thrash 阈值：窗口内同文件编辑次数上限（默认 5）。 */
  readonly maxEditsPerFile?: number;
  /** 振荡灵敏度：指纹重现间隔（两态之间的中间态数）下限；默认 1（A→B→A 即告警）。 */
  readonly oscillationGap?: number;
}

/**
 * 编辑漂移检测器：逐条 `record()` 编辑事件，命中告警条件即在返回值里给出
 * DriftAlarm（不抛错——告警是给上层策略降速/换路用的信号，不是故障）。
 */
export class EditDriftDetector {
  /** 窗口大小（最近 N 次编辑内统计）。 */
  private readonly windowSize: number;
  /** thrash 阈值：窗口内同文件编辑次数上限。 */
  private readonly maxEditsPerFile: number;
  /** 振荡灵敏度：指纹重现间隔下限。 */
  private readonly oscillationGap: number;
  /** 滑动窗口（最近的编辑事件）。 */
  private readonly window: EditEvent[] = [];
  /** 每文件的内容指纹历史（仅窗口内的循环判定用）。 */
  private readonly revisions = new Map<string, string[]>();

  /**
   * @param opts 检测参数（窗口/阈值/振荡灵敏度）
   */
  public constructor(opts: DriftDetectorOptions = {}) {
    this.windowSize = Math.max(4, Math.floor(opts.windowSize ?? 20));
    this.maxEditsPerFile = Math.max(2, Math.floor(opts.maxEditsPerFile ?? 5));
    this.oscillationGap = Math.max(1, Math.floor(opts.oscillationGap ?? 1));
  }

  /**
   * 记录一次编辑并检查是否触发告警。内容指纹与该文件上一条相同视为 no-op（未编辑），
   * 不进窗口、不计次数、直接放行。
   * @param event 编辑事件（文件 + 新内容指纹）
   * @returns 命中的告警；未命中返回 undefined
   */
  public record(event: EditEvent): DriftAlarm | undefined {
    const seq = this.revisions.get(event.file);
    if (seq !== undefined && seq[seq.length - 1] === event.revision) return undefined; // 内容未变：非编辑

    this.window.push(event);
    if (this.window.length > this.windowSize) this.window.shift();

    // 同文件指纹历史（追加 + 修剪到窗口长度）。record 入口已保证 revision 与上一条不同。
    const history = this.revisions.get(event.file) ?? [];
    history.push(event.revision);
    while (history.length > this.windowSize) history.shift();
    this.revisions.set(event.file, history);

    // ① 振荡：指纹在 ≥ oscillationGap 个中间态后重现（A→B→A）。
    if (history.length >= this.oscillationGap + 2) {
      const cur = history[history.length - 1]!;
      const prevIdx = history.slice(0, -1).lastIndexOf(cur);
      if (prevIdx >= 0 && history.length - 1 - prevIdx - 1 >= this.oscillationGap) {
        return {
          kind: 'oscillation',
          file: event.file,
          detail: `指纹回退循环：${history.join('→')}（重现间隔 ${history.length - 1 - prevIdx - 1} 步）`,
        };
      }
    }

    // ② 高频重写：窗口内同文件编辑次数超阈值。
    const inWindow = this.window.filter((e) => e.file === event.file).length;
    if (inWindow > this.maxEditsPerFile) {
      return {
        kind: 'thrash',
        file: event.file,
        detail: `窗口 ${this.windowSize} 次编辑中 ${inWindow} 次落在同一文件（阈值 ${this.maxEditsPerFile}）`,
      };
    }
    return undefined;
  }

  /**
   * 已记录的事件总数。
   * @returns 当前窗口内的事件数
   */
  public get recorded(): number {
    return this.window.length;
  }

  /**
   * 清空状态（新一轮任务）。
   * @returns 无返回值（void）。
   */
  public reset(): void {
    this.window.length = 0;
    this.revisions.clear();
  }
}
