import { open, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { TOOL_NAMES } from '../../../ports/tool/toolNames.js';
import { MediaSniffer } from '../../../media/mediaSniffer.js';
import { RoutingFrameExtractor } from '../../media/routingFrameExtractor.js';
import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../../ports/tool/tool.js';
import type { FileAttachment } from '../../../ports/model/model.js';
import type { MediaFrameExtractor } from '../../../ports/media/frameExtractor.js';
import type {
  FrameSelectionPolicy,
  FrameStrategy,
  MediaFrame,
  MediaProbeInfo,
} from '../../../ports/media/mediaTypes.js';
import type { ResolvedMediaOptions } from '../../../config/mediaConfigResolver.js';
import { WorkspaceGuard } from '../../../util/workspaceGuard.js';

/** 嗅探所需的文件头字节数（足以覆盖所有魔数与图片头）。 */
const HEAD_BYTES = 64 * 1024;

/** 构造参数。 */
export interface ViewMediaToolOptions {
  /** 工作区根目录（读取目标必须落在其内）。 */
  readonly workspaceRoot: string;
  /** 帧提取路由。 */
  readonly extractor: MediaFrameExtractor;
  /** 已解析的媒体选项（预算与超时）。 */
  readonly options: ResolvedMediaOptions;
}

/**
 * 媒体抽帧工具：`view_media` —— 让模型「一帧一帧看」动画 GIF 与视频。
 *
 * ## 为什么必须有这个工具（而不是扩展 `view_image`）
 *
 * `view_image` 把整份文件当**一张静态图**交给模型：对动画 GIF 与视频，这等于只看第一帧，
 * 而压缩后的单张字节通常还大到被上限直接拒收。要让模型理解「过程」（动作、转场、
 * 状态迁移、UI 交互），数据通道必须交付**有序多帧 + 每帧时刻**。
 * 两者交付语义不同（一条图 vs 一条时间序列），合并进同一个工具只会让描述与参数
 * 互相污染，故按「静止 / 运动」分成两个工具，且互相给出转介提示。
 *
 * ## 通道
 *
 * 帧走 {@link ToolResult.files}（工具结果事件 → 上下文组装器 → 模型消息），
 * 与 `view_image` 完全同一条通道：组装器把附件作为**一条独立 user 消息**追加在所有
 * tool 消息之后（插在 tool 消息之间会破坏 `assistant(tool_calls)` ↔ `tool` 配对 ⇒ HTTP 400）。
 * 附件的**文件名里带序号与时间点**（`xx#03_t=1.200s.png`）——组装器注入的文本只有文件名，
 * 名字里带时序信息，模型才能在「只看名字」的那条消息里也拿到顺序。
 *
 * ## 诚实边界（写在描述与输出里，而不是藏着）
 *
 * - 视频抽帧需要**本机 ffmpeg**；没有时工具会明确说明「如何装 / 如何配置」，
 *   而不是报一句「失败」让模型反复重试。
 * - 能在多大程度上"看见"取决于模型是否支持图像输入（与本仓 `view_image` 同一前提）。
 * - 任何缩放 / 丢弃 / 裁剪都会写进输出文本（模型据此知道"这帧是缩过的"）。
 */
export class ViewMediaTool {
  /** 工具定义。 */
  public readonly definition: ToolDefinition = {
    name: TOOL_NAMES.viewMedia,
    description:
      '按时间抽帧读取动画 GIF 与视频，并把每一帧作为图片交给模型逐帧判读（动作、转场、状态变化、' +
      'UI 交互过程）。参数 path 为工作区内路径；可选 start_ms/end_ms 限定时间窗、max_frames 限定帧数、' +
      'strategy=uniform（默认，等时间间隔）或 scene（只在画面显著变化处取帧）。' +
      '支持 mp4/mov/webm/mkv/avi/ogg/mpegts/flv（需本机 ffmpeg）与动画 GIF（无需外部工具）。' +
      '静态图片请改用 view_image。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区的媒体文件路径（须已存在）' },
        start_ms: { type: 'number', description: '采样窗口起点（毫秒），默认 0' },
        end_ms: { type: 'number', description: '采样窗口终点（毫秒），默认到结尾' },
        max_frames: { type: 'number', description: '最多交付多少帧（受配置上限约束）' },
        strategy: {
          type: 'string',
          enum: ['uniform', 'scene'],
          description: 'uniform＝等时间间隔（默认）；scene＝只在画面显著变化处取帧',
        },
      },
      required: ['path'],
    },
  };

  /**
   * @param options 工作区根、提取路由与媒体选项。
   */
  public constructor(private readonly options: ViewMediaToolOptions) {}

  /**
   * 抽帧并把帧作为附件交付。
   *
   * @param call 工具调用（实参含 path / start_ms / end_ms / max_frames / strategy）。
   * @param context 工具上下文（提供会话取消信号）。
   * @returns 成功时 `output` 为逐帧清单、`files` 为帧附件；失败时 `ok:false` 且 `error` 可行动。
   */
  public async handle(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    const relative = String(call.arguments['path'] ?? '');
    const guard = new WorkspaceGuard(this.options.workspaceRoot);
    if (!guard.isInside(relative)) {
      return {
        callId: call.id,
        ok: false,
        error:
          `路径越界: "${relative}" 不在工作区内。工作区根目录为 ${this.options.workspaceRoot}，` +
          '请改用相对此根目录的路径。',
      };
    }
    const absolute = guard.resolveSafe(relative);
    const size = await ViewMediaTool.fileSize(absolute);
    if (size === undefined) {
      return {
        callId: call.id,
        ok: false,
        error: `${relative} 不存在或不可读（请先用 glob/list_dir 确认路径）`,
      };
    }
    const head = await ViewMediaTool.readHead(absolute);
    if (head === undefined) {
      return { callId: call.id, ok: false, error: `${relative} 读取失败（前 64KB 未能读出）` };
    }
    const probe = MediaSniffer.sniff(head, extname(relative).toLowerCase());
    const selection = this.selectionOf(call);
    const result = await this.options.extractor.extract({
      absolutePath: absolute,
      probe,
      selection,
      timeoutMs: this.options.options.timeoutMs,
      ...(context.signal !== undefined ? { signal: context.signal } : {}),
    });
    if (result.frames.length === 0) {
      return {
        callId: call.id,
        ok: false,
        error: ViewMediaTool.failureText(relative, result.probe, result.notes),
      };
    }
    return {
      callId: call.id,
      ok: true,
      output: ViewMediaTool.describe(
        relative,
        size,
        selection,
        result.probe,
        result.frames,
        result.notes,
      ),
      files: result.frames.map((frame) => ViewMediaTool.attachment(relative, frame)),
    };
  }

  /**
   * 由工具实参与配置组装采样约束（实参缺省即用配置值）。
   *
   * @param call 工具调用。
   * @returns 采样与预算约束。
   */
  private selectionOf(call: ToolCall): FrameSelectionPolicy {
    const resolved = this.options.options;
    return {
      strategy: ViewMediaTool.strategyOf(call.arguments['strategy']),
      maxFrames: ViewMediaTool.clamp(
        ViewMediaTool.countOf(call.arguments['max_frames']),
        1,
        resolved.maxFrames,
      ),
      startMs: Math.max(0, ViewMediaTool.countOf(call.arguments['start_ms']) ?? 0),
      endMs: ViewMediaTool.countOf(call.arguments['end_ms']),
      sceneThreshold: resolved.sceneThreshold,
      maxDimension: resolved.maxDimension,
      maxFrameBytes: resolved.maxFrameBytes,
      maxTotalBytes: resolved.maxTotalBytes,
    };
  }

  /**
   * 组织输出文本（逐帧清单 + 生效预算 + 过程说明）。
   *
   * @param relative 源相对路径。
   * @param bytes 源字节数。
   * @param selection 生效的采样约束。
   * @param probe 探测到的元数据。
   * @param frames 交付的帧。
   * @param notes 过程说明。
   * @returns 输出文本。
   */
  private static describe(
    relative: string,
    bytes: number,
    selection: FrameSelectionPolicy,
    probe: MediaProbeInfo,
    frames: readonly MediaFrame[],
    notes: readonly string[],
  ): string {
    const size =
      probe.width === undefined || probe.height === undefined
        ? '尺寸未知'
        : `${String(probe.width)}×${String(probe.height)}`;
    const header =
      `已抽帧读取 ${relative}（${probe.kind}/${probe.container}${probe.codec === undefined ? '' : `，${probe.codec}`}，` +
      `${size}，${String(bytes)} 字节）\n` +
      `源信息：时长 ${ViewMediaTool.seconds(probe.durationMs)}，帧数 ${probe.frameCount === undefined ? '未知' : String(probe.frameCount)}，` +
      `帧率 ${probe.frameRate === undefined ? '未知' : probe.frameRate.toFixed(2)}\n` +
      `采样：${selection.strategy === 'uniform' ? '等时间间隔' : `场景变化（阈值 ${String(selection.sceneThreshold)}）`}` +
      `，起点 ${String(selection.startMs)}ms，帧数上限 ${String(selection.maxFrames)}，` +
      `单帧长边上限 ${String(selection.maxDimension)}px\n`;
    const rows = frames
      .map((frame) => {
        const duration =
          frame.durationMs === undefined ? '' : ` 时长 ${String(frame.durationMs)}ms`;
        return (
          `  #${String(frame.index)} t=${(frame.timestampMs / 1000).toFixed(3)}s ` +
          `${String(frame.width)}×${String(frame.height)} ${String(frame.bytes.byteLength)}B${duration}`
        );
      })
      .join('\n');
    const total = frames.reduce((sum, frame) => sum + frame.bytes.byteLength, 0);
    const notesText =
      notes.length === 0 ? '' : `\n过程说明：\n${notes.map((note) => `  - ${note}`).join('\n')}`;
    return (
      `${header}共交付 ${String(frames.length)} 帧（合计 ${String(total)} 字节），按时间升序编号 #0…#${String(frames.length - 1)}：\n` +
      `${rows}\n` +
      '帧图片已作为附件随本轮工具结果送入模型（文件名含序号与时间点）；' +
      '若当前模型不支持图像输入，则只能看到本行文字。请结合每帧的时间点描述发生的过程与变化。' +
      notesText
    );
  }

  /**
   * 把交付的帧转成附件（文件名携带序号与时间点）。
   *
   * @param relative 源相对路径。
   * @param frame 帧。
   * @returns 文件附件。
   */
  private static attachment(relative: string, frame: MediaFrame): FileAttachment {
    const extension = frame.mediaType === 'image/jpeg' ? 'jpg' : 'png';
    const order = String(frame.index).padStart(2, '0');
    return {
      name: `${basename(relative)}#${order}_t=${(frame.timestampMs / 1000).toFixed(3)}s.${extension}`,
      mediaType: frame.mediaType,
      data: frame.bytes.toString('base64'),
    };
  }

  /**
   * 组织「未能交付任何帧」的错误文本（原因优先取自提取器给出的 `notes`）。
   *
   * 路由层的可行动提示与提取器的失败原因**都**在 `notes` 里，此处只负责拼装，
   * 不重复前置——避免同一句提示出现两遍。
   *
   * @param relative 源相对路径。
   * @param probe 探测到的元数据（`notes` 为空时才用它兜底给转介提示）。
   * @param notes 过程说明（含原因）。
   * @returns 错误文本。
   */
  private static failureText(
    relative: string,
    probe: MediaProbeInfo,
    notes: readonly string[],
  ): string {
    // 路由层在「无实现支持该大类」时**已经**把可行动提示放进了 `notes`（文案单一来源），
    // 故此处只在 `notes` 为空（提取器自身失败且未给原因）时才用路由文案兜底。
    // 曾经这里无条件前置一次 explain ⇒ 同一句话出现两遍，模型会误以为存在两个不同的问题。
    const reason =
      notes.length === 0
        ? RoutingFrameExtractor.explain(probe.kind, probe.container)
        : notes.join('；');
    return `${relative} 未能抽出任何帧：${reason}`;
  }

  /**
   * 解析策略实参（非法值回落 `uniform`）。
   *
   * @param raw 原始实参。
   * @returns 采样策略。
   */
  private static strategyOf(raw: unknown): FrameStrategy {
    return raw === 'scene' ? 'scene' : 'uniform';
  }

  /**
   * 解析数值实参（非有限数返回 `undefined`）。
   *
   * @param raw 原始实参。
   * @returns 数值；不可用时为 `undefined`。
   */
  private static countOf(raw: unknown): number | undefined {
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return raw;
    }
    if (typeof raw === 'string' && raw.trim() !== '') {
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
  }

  /**
   * 收敛到区间。
   *
   * @param value 候选值（`undefined` 时取上界）。
   * @param min 下界。
   * @param max 上界。
   * @returns 收敛后的整数。
   */
  private static clamp(value: number | undefined, min: number, max: number): number {
    if (value === undefined) {
      return max;
    }
    return Math.min(max, Math.max(min, Math.round(value)));
  }

  /**
   * 秒数展示（未知返回「未知」）。
   *
   * @param ms 毫秒。
   * @returns 展示文本。
   */
  private static seconds(ms: number | undefined): string {
    return ms === undefined ? '未知' : `${(ms / 1000).toFixed(3)}s`;
  }

  /**
   * 读取文件大小。
   *
   * @param absolute 绝对路径。
   * @returns 字节数；读取失败时为 `undefined`。
   */
  private static async fileSize(absolute: string): Promise<number | undefined> {
    try {
      return (await stat(absolute)).size;
    } catch {
      return undefined;
    }
  }

  /**
   * 只读文件头（避免为嗅探把整个大文件读进内存）。
   *
   * @param absolute 绝对路径。
   * @returns 头部字节；读取失败时为 `undefined`。
   */
  private static async readHead(absolute: string): Promise<Buffer | undefined> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(absolute, 'r');
      const buffer = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
      return buffer.subarray(0, bytesRead);
    } catch {
      return undefined;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}
