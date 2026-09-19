/**
 * 网页截图工具（P2-⑬ 的最后一环）：`browser_screenshot`。
 *
 * ## 为什么需要
 *
 * 在此之前，「看一眼自己做出来的页面」这件事在 OmniHarness 里是**做不到的**：
 * CDP 截图只存在于 `web/test/`，是测试脚本的能力，模型既不能调用、也看不到结果。
 * 于是「改完前端 → 确认页面没崩、样式没歪」这条闭环断在最后一米。
 *
 * ## 通道
 *
 * 与 `view_image` 同一条：图片走 {@link ToolResult.files} → 工具结果事件 →
 * 上下文组装器 → 作为尾部一条 user 消息注入模型（**不能**插在 tool 消息之间，
 * 那会破坏 `assistant(tool_calls)`↔`tool` 配对，OpenAI 兼容端点会回 HTTP 400）。
 * `output` 里只放元数据与落盘路径，避免把 base64 噪声灌进上下文。
 *
 * ## 归属
 *
 * 本工具**写文件**（PNG 落盘），故归 `file_write`：进 `MUTATING_TOOLS`、
 * **不**进 `planApproval` 只读白名单——plan 模式下应当被拦，这与其他写类工具一致。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../../ports/tool/tool.js';
import type { FileAttachment } from '../../../ports/model/model.js';
import type { ScreenshotRequest, ScreenshotResult } from '../../browser/browserSession.js';
import { BrowserSession } from '../../browser/browserSession.js';
import { BrowserAvailability } from '../../browser/browserAvailability.js';
import type {
  BrowserAvailabilityInput,
  BrowserAvailabilityReport,
} from '../../browser/browserAvailability.js';
import { WorkspaceGuard } from '../../../util/workspaceGuard.js';

/** 会话接缝：只暴露本工具要用的两个方法，便于测试注入假实现（不真起浏览器）。 */
export interface ScreenshotSession {
  /**
   * 打开页面并截图。
   *
   * @param request 截图请求。
   * @returns 截图结果。
   */
  screenshot(request: ScreenshotRequest): Promise<ScreenshotResult>;

  /**
   * 关闭会话。
   *
   * @returns 关闭完成。
   */
  close(): Promise<void>;
}

/** 会话工厂（每次工具实例只建一次）。 */
export type ScreenshotSessionFactory = () => ScreenshotSession;

/**
 * 网页截图工具：打开 URL、截图、落盘、并把图片作为附件交给模型。
 */
export class BrowserScreenshotTool {
  /** 图片字节上限（5 MiB，与 `view_image` 一致）。 */
  public static readonly MAX_IMAGE_BYTES = 5 * 1024 * 1024;

  /** 视口尺寸下界。 */
  public static readonly MIN_DIMENSION = 64;

  /** 视口尺寸上界。 */
  public static readonly MAX_DIMENSION = 4096;

  /** 默认视口宽。 */
  public static readonly DEFAULT_WIDTH = 1280;

  /** 默认视口高。 */
  public static readonly DEFAULT_HEIGHT = 800;

  /** 默认加载后额外等待毫秒数。 */
  public static readonly DEFAULT_WAIT_MS = 500;

  /** 额外等待的上界（防止模型申请一个把整轮拖死的等待）。 */
  public static readonly MAX_WAIT_MS = 20_000;

  /** 工具定义。 */
  public readonly definition: ToolDefinition = {
    name: 'browser_screenshot',
    description:
      '用本机 Chrome/Edge（headless）打开一个网页并截图，图片会作为附件送入模型，可直接查看页面渲染效果。' +
      '适用于「改完前端确认样式/布局」、核对网页内容。仅支持 http/https/data 地址；会把 PNG 写入工作区。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要截图的地址（http://、https:// 或 data:）。' },
        output_path: {
          type: 'string',
          description:
            'PNG 落盘的相对路径（相对工作区）；缺省写到 .omniharness/screenshots/ 下的时间戳文件。',
        },
        width: {
          type: 'number',
          description: `视口宽（${String(64)}-${String(4096)}，默认 1280）。`,
        },
        height: {
          type: 'number',
          description: `视口高（${String(64)}-${String(4096)}，默认 800）。`,
        },
        full_page: {
          type: 'boolean',
          description: '是否截取整个可滚动区域（默认 false，只截视口）。',
        },
        wait_ms: {
          type: 'number',
          description: `加载完成后的额外等待毫秒数（默认 ${String(500)}，上限 ${String(20_000)}），给动画/异步渲染留时间。`,
        },
      },
      required: ['url'],
    },
  };

  /** 懒建的浏览器会话（跨调用复用；同一工具实例只起一个浏览器）。 */
  private session: ScreenshotSession | undefined;

  /**
   * @param workspaceRoot 工作区根目录（落盘目标必须落在其内）。
   * @param factory 会话工厂（缺省起真实 headless Chromium；测试可注入假实现）。
   */
  public constructor(
    private readonly workspaceRoot: string,
    private readonly factory: ScreenshotSessionFactory = (): ScreenshotSession =>
      new BrowserSession(),
  ) {}

  /**
   * 执行 browser_screenshot。
   *
   * @param call 工具调用（实参含 url 及可选的落盘路径 / 视口 / 等待）。
   * @param _context 工具上下文（本工具未使用，忽略）。
   * @returns 成功时 `output` 为元数据、`files` 为 PNG 附件；参数非法或截图失败时 ok:false。
   */
  public async handle(call: ToolCall, _context: ToolContext): Promise<ToolResult> {
    const url = String(call.arguments['url'] ?? '').trim();
    const schemeError = BrowserScreenshotTool.checkScheme(url);
    if (schemeError !== '') {
      return { callId: call.id, ok: false, error: schemeError };
    }
    const request: ScreenshotRequest = {
      url,
      width: BrowserScreenshotTool.clamp(
        call.arguments['width'],
        BrowserScreenshotTool.DEFAULT_WIDTH,
      ),
      height: BrowserScreenshotTool.clamp(
        call.arguments['height'],
        BrowserScreenshotTool.DEFAULT_HEIGHT,
      ),
      fullPage: call.arguments['full_page'] === true,
      waitMs: BrowserScreenshotTool.clamp(
        call.arguments['wait_ms'],
        BrowserScreenshotTool.DEFAULT_WAIT_MS,
        BrowserScreenshotTool.MAX_WAIT_MS,
      ),
    };
    const target = this.resolveOutputPath(call.arguments['output_path']);
    if ('error' in target) {
      return { callId: call.id, ok: false, error: target.error };
    }

    let shot: ScreenshotResult;
    try {
      shot = await this.requireSession().screenshot(request);
    } catch (error) {
      return { callId: call.id, ok: false, error: BrowserScreenshotTool.failure(error) };
    }
    if (shot.png.byteLength > BrowserScreenshotTool.MAX_IMAGE_BYTES) {
      return {
        callId: call.id,
        ok: false,
        error:
          `截图 ${String(shot.png.byteLength)} 字节，超过单张上限 ${String(BrowserScreenshotTool.MAX_IMAGE_BYTES)} 字节。` +
          '请改小 width/height 或关闭 full_page 后重试。',
      };
    }
    try {
      await mkdir(dirname(target.absolute), { recursive: true });
      await writeFile(target.absolute, shot.png);
    } catch (error) {
      return {
        callId: call.id,
        ok: false,
        error: `截图写入失败: ${BrowserScreenshotTool.detailOf(error)}`,
      };
    }
    return {
      callId: call.id,
      ok: true,
      output: BrowserScreenshotTool.describe(target.relative, shot),
      files: [
        {
          name: target.relative.split(/[\\/]/).pop() ?? 'screenshot.png',
          mediaType: 'image/png',
          data: shot.png.toString('base64'),
        } satisfies FileAttachment,
      ],
    };
  }

  /**
   * 关闭浏览器（幂等）。由组合根在会话收尾时调用，避免留下常驻进程。
   *
   * @returns 关闭完成。
   */
  public async close(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    await session?.close();
  }

  /**
   * 探测本机截图能力（供组合根在注册前判定）。
   *
   * 为什么把探测做成**独立静态入口**：本工具依赖两件代码外的事实（装了 Chromium 系浏览器，
   * 或有一个可连的 CDP 端点）。二者都不成立时，注册它就等于给模型暴露一个必然失败的死工具，
   * 模型会反复重试；组合根可用本方法在注册前先问一句，并把 `reason` 转成可执行的提示。
   *
   * @param input 探测输入（可注入，便于测试脱离本机环境）。
   * @returns 可用性报告（含类别与可执行原因）。
   */
  public static async availability(
    input: BrowserAvailabilityInput = {},
  ): Promise<BrowserAvailabilityReport> {
    return await BrowserAvailability.probe(input);
  }

  /**
   * 懒建并返回会话。
   *
   * @returns 会话实例。
   */
  private requireSession(): ScreenshotSession {
    this.session ??= this.factory();
    return this.session;
  }

  /**
   * 解析落盘路径：缺省给时间戳文件；给了路径则必须落在工作区内。
   *
   * @param raw 模型给的 output_path（可为缺省）。
   * @returns 绝对路径与相对路径；越界时为错误文案。
   */
  private resolveOutputPath(
    raw: unknown,
  ): { readonly absolute: string; readonly relative: string } | { readonly error: string } {
    const requested = typeof raw === 'string' ? raw.trim() : '';
    if (requested === '') {
      const name = `screenshots/${String(Date.now())}.png`;
      return {
        absolute: resolve(this.workspaceRoot, '.omniharness', name),
        relative: `.omniharness/${name}`,
      };
    }
    if (isAbsolute(requested)) {
      return { error: `output_path 必须是相对工作区的路径，收到绝对路径: ${requested}` };
    }
    if (!new WorkspaceGuard(this.workspaceRoot).isInside(requested)) {
      return {
        error: `路径越界: "${requested}" 不在工作区内。工作区根目录为 ${this.workspaceRoot}，请改用相对此根目录的路径。`,
      };
    }
    const absolute = resolve(this.workspaceRoot, requested);
    return {
      absolute,
      relative: relative(this.workspaceRoot, absolute).replace(/\\/g, '/') || requested,
    };
  }

  /**
   * 校验地址协议。
   *
   * @param url 目标地址。
   * @returns 合法时为空串，否则为错误文案。
   */
  private static checkScheme(url: string): string {
    if (url === '') {
      return '缺少 url 参数';
    }
    if (!/^(https?|data):/i.test(url)) {
      return `不支持的地址协议（仅 http/https/data）: ${url}`;
    }
    return '';
  }

  /**
   * 把可选数值夹紧到区间内（缺失/非法回落默认；比 1ms 还小的值会被判为非法而不是被夹到边界）。
   *
   * @param raw 原始参数值。
   * @param fallback 默认值。
   * @param max 允许上界（默认按视口尺寸上界）。
   * @returns 夹紧后的整数。
   */
  private static clamp(
    raw: unknown,
    fallback: number,
    max: number = BrowserScreenshotTool.MAX_DIMENSION,
  ): number {
    if (raw === undefined || raw === null || raw === '') {
      return fallback;
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      return fallback;
    }
    return Math.min(Math.max(Math.round(value), BrowserScreenshotTool.MIN_DIMENSION), max);
  }

  /**
   * 组织元数据说明。
   *
   * @param relative 落盘相对路径。
   * @param shot 截图结果。
   * @returns 可读说明。
   */
  private static describe(relative: string, shot: ScreenshotResult): string {
    return (
      `已截图 ${shot.finalUrl}（${String(shot.width)}×${String(shot.height)}，${String(shot.png.byteLength)} 字节）` +
      `，已保存到 ${relative}。图片已作为附件随本轮工具结果送入模型；` +
      '若当前模型不支持图像输入，则只能看到本行说明。'
    );
  }

  /**
   * 把失败原因转成对模型可行动的人话。
   *
   * 三类失败（未装浏览器 / CDP 端点连不上 / 超时）补救动作完全不同，故经
   * {@link BrowserAvailability.classifyError} 分类后各给一段可执行建议——只说「失败」
   * 会让模型盲目重试同一件必然失败的事。
   *
   * @param error 抛出的任意值。
   * @returns 错误文案（始终带「网页截图失败」前缀，便于上层归因）。
   */
  private static failure(error: unknown): string {
    const detail = BrowserScreenshotTool.detailOf(error);
    const kind = BrowserAvailability.classifyError(error);
    const label = BrowserScreenshotTool.labelOf(kind);
    if (label === '') {
      return `网页截图失败: ${detail}`;
    }
    return `网页截图失败（${label}）: ${detail}。${BrowserAvailability.advice(kind)}`;
  }

  /**
   * 把失败类别翻译成简短标签（`unknown` 不贴标签，保持文案原样）。
   *
   * @param kind 失败类别。
   * @returns 中文标签；未知类别为空串。
   */
  private static labelOf(kind: ReturnType<typeof BrowserAvailability.classifyError>): string {
    switch (kind) {
      case 'chrome-missing':
        return '未安装浏览器';
      case 'cdp-unreachable':
        return 'CDP 端点不可达';
      case 'cdp-timeout':
        return '浏览器无响应或探测超时';
      default:
        return '';
    }
  }

  /**
   * 提取错误消息文本。
   *
   * @param error 抛出的任意值。
   * @returns Error 取 message，其余 String()。
   */
  private static detailOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
