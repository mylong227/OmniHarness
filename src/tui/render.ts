/**
 * 零依赖 TUI 渲染（#S35，对标 codex-rs/tui 的「会话事件流渲染」概念）。
 *
 * 不搬 codex 的 288k 行全功能 TUI（React 式组件树、app-server 协议等）；只搬其
 * **可移植内核**——把 SessionEvent 渲染为带 ANSI 颜色的终端行，供交互式会话使用。
 * 纯函数、零依赖（仅 ANSI 转义），便于单测与在 `interactive.ts` 中复用。
 */

/**
 * 零依赖 TUI 渲染器：原模块级纯函数归拢为 `TuiRenderer` 静态方法族，
 * 调用点（interactive.ts 等）通过同名 `export const` 别名零改动引用。
 */
export class TuiRenderer {
  /** ANSI 颜色码（暗色终端友好，跟随终端主题）。 */
  private static readonly ANSI = {
    reset: '\x1b[0m',
    dim: '\x1b[2m',
    bold: '\x1b[1m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
  } as const;

  /**
   * @beta
   * 按终端宽度截断（近似：CJK 计 2 宽）。
   */
  public static truncateToWidth(input: string, width: number): string {
    if (width <= 0) return '';
    let cols = 0;
    let out = '';
    for (const ch of input) {
      const w = ch.charCodeAt(0) > 0x2e80 ? 2 : 1;
      if (cols + w > width) {
        out += '…';
        break;
      }
      out += ch;
      cols += w;
    }
    return out;
  }

  private static color(kind: TuiEventKind): string {
    switch (kind) {
      case 'assistant':
        return TuiRenderer.ANSI.green;
      case 'tool_call':
        return TuiRenderer.ANSI.cyan;
      case 'tool_result':
        return TuiRenderer.ANSI.dim;
      case 'question':
        return TuiRenderer.ANSI.yellow;
      case 'error':
        return TuiRenderer.ANSI.red;
      case 'turn_diff':
        return TuiRenderer.ANSI.dim;
      case 'system':
      default:
        return TuiRenderer.ANSI.dim;
    }
  }

  private static readonly PREFIX: Record<TuiEventKind, string> = {
    assistant: '◆',
    tool_call: '⚙',
    tool_result: '↳',
    turn_diff: '∆',
    question: '?',
    error: '✗',
    system: '·',
  };

  /**
   * @beta
   * 渲染单行事件（带 ANSI 颜色 + 前缀）。
   */
  public static renderEventLine(ev: TuiEvent): string {
    const c = TuiRenderer.color(ev.kind);
    const head = `${c}${TuiRenderer.ANSI.bold}${TuiRenderer.PREFIX[ev.kind]}${TuiRenderer.ANSI.reset}`;
    const meta = ev.meta !== undefined ? ` ${TuiRenderer.ANSI.dim}[${ev.meta}]${TuiRenderer.ANSI.reset}` : '';
    return `${head} ${c}${ev.text}${TuiRenderer.ANSI.reset}${meta}`;
  }

  /**
   * @beta
   * 渲染状态行（如「运行中 / 已暂停」）。
   */
  public static renderStatusLine(status: string, detail?: string): string {
    const d = detail !== undefined ? ` ${TuiRenderer.ANSI.dim}· ${detail}${TuiRenderer.ANSI.reset}` : '';
    return `${TuiRenderer.ANSI.bold}${TuiRenderer.ANSI.cyan}●${TuiRenderer.ANSI.reset} ${TuiRenderer.ANSI.cyan}${status}${TuiRenderer.ANSI.reset}${d}`;
  }

  /**
   * @beta
   * 清行（用于进度刷新）。
   */
  public static clearLine(): string {
    return '\x1b[2K\r';
  }

  /**
   * @beta
   * 提示符（用户输入行前缀）。
   */
  public static prompt(prefix = 'you'): string {
    return `${TuiRenderer.ANSI.yellow}${prefix}>${TuiRenderer.ANSI.reset} `;
  }

  /**
   * @beta
   * 渲染工具参数渐进（#B3）：供 ConsoleLiveView / TUI 复用，带 ANSI 颜色 + 前缀。
   */
  public static renderToolInputProgress(opts: { readonly name: string; readonly json: string }): string {
    const c = TuiRenderer.ANSI.cyan;
    const head = `${c}${TuiRenderer.ANSI.bold}⚙${TuiRenderer.ANSI.reset}`;
    const preview = TuiRenderer.truncateToWidth(opts.json, 64);
    return `${head} ${c}调用 ${opts.name}${TuiRenderer.ANSI.reset} ${TuiRenderer.ANSI.dim}参数: ${preview}${TuiRenderer.ANSI.reset}`;
  }
}

// ---- 门面兼容：保留原导出名 ----
export const truncateToWidth = TuiRenderer.truncateToWidth;
export const renderEventLine = TuiRenderer.renderEventLine;
export const renderStatusLine = TuiRenderer.renderStatusLine;
export const clearLine = TuiRenderer.clearLine;
export const prompt = TuiRenderer.prompt;
export const renderToolInputProgress = TuiRenderer.renderToolInputProgress;

/**
 * @beta
 */
export type TuiEventKind =
  | 'assistant'
  | 'tool_call'
  | 'tool_result'
  | 'turn_diff'
  | 'question'
  | 'error'
  | 'system';

/**
 * @beta
 * 待渲染的事件（SessionEvent 的精简视图）。
 */
export interface TuiEvent {
  readonly kind: TuiEventKind;
  readonly text: string;
  readonly meta?: string;
}
