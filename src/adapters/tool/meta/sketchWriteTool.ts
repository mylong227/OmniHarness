import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../../ports/tool/tool.js';
import { WorkspaceGuard } from '../../../util/workspaceGuard.js';

/** 草图目录（相对工作区，与 `.omniharness/sessions` 同约定）。 */
const SKETCH_DIR = '.omniharness/sketches';

/** 受支持的草图格式 → 文件扩展名（白名单；白名单外一律拒绝，不猜）。 */
const FORMAT_EXTENSIONS: Readonly<Record<string, string>> = {
  mermaid: 'mmd',
  svg: 'svg',
  text: 'txt',
};

/** slug 最大长度（防止模型给出超长名字撞上文件系统长度上限）。 */
const MAX_SLUG_LENGTH = 48;

/**
 * 绘图（草图）工具：把模型产出的 Mermaid / SVG / 纯文本草图落成工作区文件。
 *
 * 为什么是「落文件」而不是「只在对话里贴代码」：草图是**可回看的中间产物**——
 * 后续回合、下个会话、甚至另一个协作者都要能翻到它；只在消息流里贴一遍，
 * 关掉页面就散失了。落在 `.omniharness/sketches/` 下也保证它不污染用户源码树。
 *
 * 安全边界（fail-closed）：
 *  - 路径恒由本类拼出（目录 + 时间戳 + slug + 白名单扩展名），**不接受模型传路径**，
 *    因此不存在目录穿越面；
 *  - 仍以 `WorkspaceGuard` 复核最终相对路径落在工作区内（双保险）；
 *  - 格式不在白名单、内容为空 → 直接报错，不猜格式、不写空文件。
 */
export class SketchWriteTool {
  /** 工具定义。 */
  public readonly definition: ToolDefinition = {
    name: 'sketch_write',
    description:
      '把草图落成工作区文件（.omniharness/sketches/）：先用 mermaid 画结构/流程/' +
      '时序，或用 svg 画界面草图，再调用本工具保存。返回相对路径，供后续引用与回看。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '草图名称（用于文件名，可用中文）' },
        content: { type: 'string', description: '草图正文（mermaid 代码 / svg 标记 / 纯文本）' },
        format: {
          type: 'string',
          description: '草图格式：mermaid（默认）| svg | text',
        },
      },
      required: ['name', 'content'],
    },
  };

  /**
   * @param workspaceRoot 工作区根目录（草图目录在其下，保证产物可随项目一起提交/清理）
   */
  public constructor(private readonly workspaceRoot: string) {}

  /**
   * 执行 sketch_write：校验参数 → 拼路径 → 落盘。
   * @param call 模型传入的工具调用（name / content / format）
   * @param _context 工具上下文（本工具不需要，路径基准是构造期注入的工作区根）
   * @returns 成功时给出相对路径与字节数；参数非法 / 写盘失败时 ok=false 并附原因
   */
  public async handle(call: ToolCall, _context: ToolContext): Promise<ToolResult> {
    const name = typeof call.arguments['name'] === 'string' ? call.arguments['name'].trim() : '';
    const content = typeof call.arguments['content'] === 'string' ? call.arguments['content'] : '';
    const rawFormat = call.arguments['format'];
    const format = typeof rawFormat === 'string' && rawFormat !== '' ? rawFormat : 'mermaid';
    const extension = FORMAT_EXTENSIONS[format];
    if (extension === undefined) {
      return {
        callId: call.id,
        ok: false,
        error: `不支持的草图格式: ${format}（可用：${Object.keys(FORMAT_EXTENSIONS).join(' / ')}）`,
      };
    }
    if (name === '') {
      return { callId: call.id, ok: false, error: 'name 不能为空' };
    }
    if (content.trim() === '') {
      return { callId: call.id, ok: false, error: 'content 不能为空（不写空草图）' };
    }
    const relative = join(SKETCH_DIR, `${this.stamp()}-${this.slug(name)}.${extension}`);
    if (!new WorkspaceGuard(this.workspaceRoot).isInside(relative)) {
      return { callId: call.id, ok: false, error: `草图路径越界: ${relative}` };
    }
    const absolute = resolve(this.workspaceRoot, relative);
    try {
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, content, 'utf8');
      return {
        callId: call.id,
        ok: true,
        output: `草图已保存: ${relative}（${content.length} 字符，格式 ${format}）`,
      };
    } catch (error) {
      return { callId: call.id, ok: false, error: this.messageOf(error) };
    }
  }

  /** 时间戳前缀（本地时间，形如 20260913-1030），保证同一名称多次绘制不互相覆盖。
   * @returns 秒级本地时间戳字符串。
   */
  private stamp(): string {
    const now = new Date();
    const pad = (value: number): string => String(value).padStart(2, '0');
    return (
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
      `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    );
  }

  /** 把草稿名转成安全文件名：保留中英文数字与 `-` `_`，其余替换为 `-`，并截断到上限。
   * @param name 模型给出的草图名。
   * @returns 清洗截断后的安全 slug（全非法字符时回落 'sketch'）。
   */
  private slug(name: string): string {
    const cleaned = name
      .replace(/[^\u4e00-\u9fff\w-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    const safe = cleaned === '' ? 'sketch' : cleaned;
    return safe.length > MAX_SLUG_LENGTH ? safe.slice(0, MAX_SLUG_LENGTH) : safe;
  }

  /** 提取错误消息。
   * @param error 抛出的任意值。
   * @returns Error 取 message，其余转字符串。
   */
  private messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
