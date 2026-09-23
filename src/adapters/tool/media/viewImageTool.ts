/**
 * 图片读取工具（P2-⑬）：`view_image`。
 *
 * 为什么需要：E1 的零依赖 CDP 截图能力此前**只存在于测试里**，没有产品化成工具——
 * 也就是说模型能"让测试截一张图"，却不能**自己看图**（UI 还原、图表判读、报错截图归因都做不到）。
 *
 * 通道（关键设计）：图片不是塞进 `output` 文本（那只能给模型一段 base64 噪声），
 * 而是走 {@link ToolResult.files} → 工具结果事件 → 上下文组装器 → 模型消息。
 * 组装器会把附件作为**一条独立 user 消息**追加在所有 tool 消息之后（详见
 * `ContextAssembler.flushPendingAttachments` 的说明：插在 tool 消息之间会破坏配对）。
 *
 * 边界（诚实声明，不粉饰）：
 * - 能否真的"看见"取决于**模型适配器是否支持图像输入**（本仓 openai-compatible / anthropic
 *   适配器均支持 user 消息携带图像）。不支持图像输入的模型只会看到一行文字说明。
 * - 超大图片会被拒绝而不是静默压缩（压缩需要图像库，与"零依赖"冲突）。
 */
import { TOOL_NAMES } from '../../../ports/tool/toolNames.js';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../../ports/tool/tool.js';
import type { FileAttachment } from '../../../ports/model/model.js';
import { ImageProbe } from '../../../util/imageProbe.js';
import { WorkspaceGuard } from '../../../util/workspaceGuard.js';

/** 单张图片的字节上限：5 MiB（base64 后约 6.7 MiB，是常见端点单图上限之内的保守值）。 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * 图片读取工具：把工作区内的图片作为附件交给模型。
 */
export class ViewImageTool {
  /** 工具定义。 */
  public readonly definition: ToolDefinition = {
    name: TOOL_NAMES.viewImage,
    description:
      '读取工作区内的图片（png/jpg/gif/webp/bmp/svg）并交给模型查看，' +
      '适用于截图、图表、设计稿的判读。返回尺寸等元数据，图片本体作为附件送入模型。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区的图片路径（须已存在）' },
      },
      required: ['path'],
    },
  };

  /**
   * @param workspaceRoot 工作区根目录（读取目标必须落在其内，越界即拒绝）。
   */
  public constructor(private readonly workspaceRoot: string) {}

  /**
   * 读取图片并构造附件结果。
   *
   * @param call 工具调用（实参含 path）。
   * @param _context 工具上下文（本工具未使用，忽略）。
   * @returns 成功时 `output` 为元数据、`files` 为图片附件；越界 / 非图片 / 读取失败时 ok:false。
   */
  public async handle(call: ToolCall, _context: ToolContext): Promise<ToolResult> {
    const relative = String(call.arguments['path'] ?? '');
    const guard = new WorkspaceGuard(this.workspaceRoot);
    if (!guard.isInside(relative)) {
      return {
        callId: call.id,
        ok: false,
        error:
          `路径越界: "${relative}" 不在工作区内。工作区根目录为 ${this.workspaceRoot}，` +
          '请改用相对此根目录的路径。',
      };
    }
    const absolute = resolve(this.workspaceRoot, relative);
    let bytes: Buffer;
    try {
      bytes = await readFile(absolute);
    } catch (error) {
      return {
        callId: call.id,
        ok: false,
        error: ViewImageTool.readError(relative, error),
      };
    }
    const info = ImageProbe.probe(bytes, extname(relative).toLowerCase());
    if (info === undefined) {
      return {
        callId: call.id,
        ok: false,
        error: `${relative} 不是可识别的图片（仅支持 png/jpg/gif/webp/bmp/svg/ico）`,
      };
    }
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      return {
        callId: call.id,
        ok: false,
        error:
          `${relative} 体积 ${String(bytes.byteLength)} 字节，超过单张上限 ${String(MAX_IMAGE_BYTES)} 字节。` +
          '请先裁剪或缩小该图片再读取（本工具不做有损压缩，以免与「零依赖」冲突）。',
      };
    }
    return {
      callId: call.id,
      ok: true,
      output: ViewImageTool.describe(
        relative,
        info.mediaType,
        info.width,
        info.height,
        bytes.byteLength,
      ),
      files: [
        {
          name: relative.split(/[\\/]/).pop() ?? relative,
          mediaType: info.mediaType,
          data: bytes.toString('base64'),
        } satisfies FileAttachment,
      ],
    };
  }

  /**
   * 组织元数据说明（并明说"能否看见取决于模型"）。
   *
   * @param relative 图片相对路径。
   * @param mediaType MIME 类型。
   * @param width 宽度（未知为 undefined）。
   * @param height 高度（未知为 undefined）。
   * @param bytes 字节数。
   * @returns 可读说明文本。
   */
  private static describe(
    relative: string,
    mediaType: string,
    width: number | undefined,
    height: number | undefined,
    bytes: number,
  ): string {
    const size =
      width === undefined || height === undefined
        ? '尺寸未知'
        : `${String(width)}×${String(height)}`;
    return (
      `已读取图片 ${relative}（${mediaType}，${size}，${String(bytes)} 字节）。` +
      '图片已作为附件随本轮工具结果送入模型；若当前模型不支持图像输入，则只能看到本行说明。'
    );
  }

  /**
   * 把读取错误转成对模型可行动的人话。
   *
   * @param relative 目标相对路径。
   * @param error 抛出的任意值。
   * @returns 错误文案。
   */
  private static readError(relative: string, error: unknown): string {
    const detail = error instanceof Error ? error.message : String(error);
    if (/ENOENT|no such file/i.test(detail)) {
      return `${relative} 不存在或不可读（请先确认路径，或用 glob 查找图片文件）`;
    }
    return detail;
  }
}
