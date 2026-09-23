/**
 * 网页抓取工具（P2-⑬）：`web_fetch`。
 *
 * 为什么需要：仓库原先只有 `web_search`（opt-in、依赖外部搜索实现），**没有直接取网页正文**
 * 的能力——模型读到一份文档链接却打不开。本工具补上这条腿。
 *
 * 设计取舍（与 `web_search` 的差别，也是它**可以默认注册**的理由）：
 * - `web_search` 必须注入外部搜索实现，未配置时必然失败 ⇒ 默认不注册（免得模型反复撞墙）；
 * - `web_fetch` 的默认实现**自带**（Node 内置 `fetch` + 本地 HTML→文本），无需任何密钥或外部服务，
 *   因此默认注册是安全的：失败是个案的（目标站不可达），不是系统性的。
 *
 * 安全与预算：
 * - 仅允许 `http:` / `https:`（拒绝 `file:` 等本地协议，避免被当作本地文件读取绕过 WorkspaceGuard）；
 * - 响应体**边读边计数**，超过 `max_bytes` 立即取消读取（不把整个大文件拉进内存）；
 * - `timeout_ms` 默认 30s 且有上限，避免挂在一个不回的服务器上；
 * - 非 HTML 内容（JSON / 纯文本）原样返回，不做转换。
 */
import { TOOL_NAMES } from '../../../ports/tool/toolNames.js'
import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../../ports/tool/tool.js';
import { HtmlToText } from '../../../util/htmlToText.js';

/** 单次抓取的响应体默认上限（字节）。 */
const DEFAULT_MAX_BYTES = 200_000;

/** 单次抓取的响应体硬上限（字节）。 */
const HARD_MAX_BYTES = 2_000_000;

/** 默认超时（毫秒）。 */
const DEFAULT_TIMEOUT_MS = 30_000;

/** 超时上限（毫秒）。 */
const MAX_TIMEOUT_MS = 300_000;

/** 抓取到的原始响应。 */
export interface FetchedDocument {
  /** HTTP 状态码。 */
  readonly status: number;
  /** `content-type` 头（缺省为空串）。 */
  readonly contentType: string;
  /** 响应体文本（已按字节上限截断）。 */
  readonly body: string;
  /** 是否因超出字节上限被截断。 */
  readonly truncated: boolean;
}

/** 网页抓取工具选项。 */
export interface WebFetchToolOptions {
  /**
   * 抓取实现（可选）：注入后完全替代内置 `fetch`（单测零网络）。
   * 未注入时使用内置实现（Node 内置 `fetch`）。
   */
  readonly fetchDocument?: (url: string, maxBytes: number, timeoutMs: number) => Promise<FetchedDocument>;
}

/**
 * 网页抓取工具（默认注册；内置实现零依赖、零密钥）。
 */
export class WebFetchTool {
  /** 工具定义。 */
  public readonly definition: ToolDefinition = {
    name: TOOL_NAMES.webFetch,
    description:
      '抓取一个 http(s) 网页并返回正文纯文本（自动剥离脚本/样式与标签）。' +
      '用于读取文档、issue、PR 等在线内容；返回内容会按 max_bytes 截断。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要抓取的 http(s) 地址' },
        max_bytes: {
          type: 'number',
          description: `响应体字节上限（默认 ${DEFAULT_MAX_BYTES}，上限 ${HARD_MAX_BYTES}）`,
        },
        timeout_ms: {
          type: 'number',
          description: `抓取超时毫秒数（默认 ${DEFAULT_TIMEOUT_MS}，上限 ${MAX_TIMEOUT_MS}）`,
        },
      },
      required: ['url'],
    },
  };

  /**
   * @param options 工具选项（可注入抓取实现，便于离线单测）。
   */
  public constructor(private readonly options: WebFetchToolOptions = {}) {}

  /**
   * 执行抓取。
   *
   * @param call 工具调用（含 url，可选 max_bytes / timeout_ms）。
   * @param _context 工具上下文（本工具不依赖，保留签名兼容）。
   * @returns 成功时返回 `状态行 + 正文`；URL 非法 / 非 http(s) / 网络失败时返回 ok:false。
   */
  public async handle(call: ToolCall, _context: ToolContext): Promise<ToolResult> {
    const url = String(call.arguments['url'] ?? '').trim();
    if (!WebFetchTool.isHttpUrl(url)) {
      return {
        callId: call.id,
        ok: false,
        error: `仅支持 http/https URL（收到: "${url}"）`,
      };
    }
    const maxBytes = WebFetchTool.clamp(call.arguments['max_bytes'], DEFAULT_MAX_BYTES, HARD_MAX_BYTES);
    const timeoutMs = WebFetchTool.clamp(
      call.arguments['timeout_ms'],
      DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    );
    try {
      const fetched = await this.fetch(url, maxBytes, timeoutMs);
      return { callId: call.id, ok: true, output: WebFetchTool.render(url, fetched) };
    } catch (error) {
      return {
        callId: call.id,
        ok: false,
        error: `抓取失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * 取文档：优先用注入实现，否则用内置实现。
   *
   * @param url 目标地址。
   * @param maxBytes 响应体字节上限。
   * @param timeoutMs 超时毫秒数。
   * @returns 抓取结果。
   */
  private fetch(url: string, maxBytes: number, timeoutMs: number): Promise<FetchedDocument> {
    const injected = this.options.fetchDocument;
    return injected !== undefined
      ? injected(url, maxBytes, timeoutMs)
      : WebFetchTool.fetchWithBuiltin(url, maxBytes, timeoutMs);
  }

  /**
   * 内置抓取实现：Node 内置 `fetch` + 边读边限长。
   *
   * @param url 目标地址。
   * @param maxBytes 响应体字节上限。
   * @param timeoutMs 超时毫秒数。
   * @returns 抓取结果（body 已按上限截断并标记）。
   */
  private static async fetchWithBuiltin(
    url: string,
    maxBytes: number,
    timeoutMs: number,
  ): Promise<FetchedDocument> {
    const response = await globalThis.fetch(url, {
      redirect: 'follow',
      headers: { accept: 'text/html,application/json,text/plain,*/*' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const contentType = response.headers.get('content-type') ?? '';
    const read = await WebFetchTool.readBounded(response, maxBytes);
    const body = contentType.toLowerCase().includes('html')
      ? HtmlToText.convert(read.text)
      : read.text;
    return { status: response.status, contentType, body, truncated: read.truncated };
  }

  /**
   * 边读边计数地读取响应体（超限即取消读取）。
   *
   * @param response fetch 响应。
   * @param maxBytes 字节上限。
   * @returns 已读文本与「是否被截断」标记（无 body 时为空）。
   */
  private static async readBounded(
    response: Response,
    maxBytes: number,
  ): Promise<{ readonly text: string; readonly truncated: boolean }> {
    const body = response.body as ReadableStream<Uint8Array> | null;
    if (body === null) {
      return { text: '', truncated: false };
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    for (;;) {
      const step = await reader.read();
      if (step.done === true) {
        break;
      }
      if (step.value === undefined) {
        continue;
      }
      chunks.push(step.value);
      total += step.value.byteLength;
      if (total >= maxBytes) {
        truncated = true;
        await reader.cancel();
        break;
      }
    }
    return { text: Buffer.concat(chunks).toString('utf8').slice(0, maxBytes), truncated };
  }

  /**
   * 组织返回文本（状态头 + 正文）。
   *
   * @param url 目标地址。
   * @param fetched 抓取结果。
   * @returns 可读文本。
   */
  private static render(url: string, fetched: FetchedDocument): string {
    const kind = fetched.contentType === '' ? '未知类型' : fetched.contentType;
    const cut = fetched.truncated ? '，已按上限截断' : '';
    const head = `[web_fetch] ${url} → HTTP ${String(fetched.status)}（${kind}，${String(fetched.body.length)} 字符${cut}）`;
    return fetched.body === '' ? `${head}\n（响应体为空）` : `${head}\n${fetched.body}`;
  }

  /**
   * 校验 URL 是否为 http(s)。
   *
   * @param url 待校验地址。
   * @returns 合法 http/https 时为 true。
   */
  private static isHttpUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }

  /**
   * 把调用方给的上限钳制到 `[1, hardMax]`；**非正数与非有限值一律回落默认**。
   *
   * 为什么把 `<= 0` 也当非法：`timeout_ms: -5` 若按"下限 1"处理会变成 1ms 超时——
   * 表现为「抓取永远立刻失败」，极难归因（与 `ShellTool.effectiveTimeout` 的取舍一致）。
   *
   * @param requested 请求值（未知类型）。
   * @param fallback 默认值。
   * @param hardMax 硬上限。
   * @returns 生效值。
   */
  private static clamp(requested: unknown, fallback: number, hardMax: number): number {
    if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) {
      return fallback;
    }
    return Math.min(Math.floor(requested), hardMax);
  }
}
