/**
 * 零依赖 TUI 渲染（#S35，对标 codex-rs/tui 的「会话事件流渲染」概念）。
 *
 * 不搬 codex 的 288k 行全功能 TUI（React 式组件树、app-server 协议等）；只搬其
 * **可移植内核**——把 SessionEvent 渲染为带 ANSI 颜色的终端行，供交互式会话使用。
 * 纯函数、零依赖（仅 ANSI 转义），便于单测与在 `interactive.ts` 中复用。
 */

/** ANSI 颜色码（暗色终端友好，跟随终端主题）。 */
const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
} as const;

/** 事件类型 → 前缀符号。 */
const PREFIX: Record<TuiEventKind, string> = {
  assistant: '◆',
  tool_call: '⚙',
  tool_result: '↳',
  turn_diff: '∆',
  question: '?',
  error: '✗',
  system: '·',
};

/**
 * 零依赖 TUI 渲染器。
 *
 * 无状态、无 IO：同一实例可并发复用（默认实例见文件末尾组合根门面）。
 * `OOP 收口`（2026-09-11）：原静态方法族改为实例方法，消除 `static`。
 */
export class TuiRenderer {
  /**
   * @beta
   * 按终端宽度截断（近似：CJK 计 2 宽）。
   */
  public truncateToWidth(input: string, width: number): string {
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

  private color(kind: TuiEventKind): string {
    switch (kind) {
      case 'assistant':
        return ANSI.green;
      case 'tool_call':
        return ANSI.cyan;
      case 'tool_result':
        return ANSI.dim;
      case 'question':
        return ANSI.yellow;
      case 'error':
        return ANSI.red;
      case 'turn_diff':
        return ANSI.dim;
      case 'system':
      default:
        return ANSI.dim;
    }
  }

  /**
   * @beta
   * 渲染单行事件（带 ANSI 颜色 + 前缀）。
   */
  public renderEventLine(ev: TuiEvent): string {
    const c = this.color(ev.kind);
    const head = `${c}${ANSI.bold}${PREFIX[ev.kind]}${ANSI.reset}`;
    const meta = ev.meta !== undefined ? ` ${ANSI.dim}[${ev.meta}]${ANSI.reset}` : '';
    return `${head} ${c}${ev.text}${ANSI.reset}${meta}`;
  }

  /**
   * @beta
   * 渲染状态行（如「运行中 / 已暂停」）。
   */
  public renderStatusLine(status: string, detail?: string): string {
    const d = detail !== undefined ? ` ${ANSI.dim}· ${detail}${ANSI.reset}` : '';
    return `${ANSI.bold}${ANSI.cyan}●${ANSI.reset} ${ANSI.cyan}${status}${ANSI.reset}${d}`;
  }

  /**
   * @beta
   * 清行（用于进度刷新）。
   */
  public clearLine(): string {
    return '\x1b[2K\r';
  }

  /**
   * @beta
   * 提示符（用户输入行前缀）。
   */
  public prompt(prefix = 'you'): string {
    return `${ANSI.yellow}${prefix}>${ANSI.reset} `;
  }

  /**
   * @beta
   * 渲染工具参数渐进（#B3）：供 ConsoleLiveView / TUI 复用，带 ANSI 颜色 + 前缀。
   */
  public renderToolInputProgress(opts: { readonly name: string; readonly json: string }): string {
    const c = ANSI.cyan;
    const head = `${c}${ANSI.bold}⚙${ANSI.reset}`;
    const preview = this.truncateToWidth(opts.json, 64);
    return `${head} ${c}调用 ${opts.name}${ANSI.reset} ${ANSI.dim}参数: ${preview}${ANSI.reset}`;
  }
}

// ---- 门面兼容：保留原导出名，委托默认实例 ----
const tuiRenderer = new TuiRenderer();

/**
 * @beta
 * 按终端宽度截断（近似：CJK 计 2 宽）。
 */
export function truncateToWidth(input: string, width: number): string {
  return tuiRenderer.truncateToWidth(input, width);
}

/**
 * @beta
 * 渲染单行事件（带 ANSI 颜色 + 前缀）。
 */
export function renderEventLine(ev: TuiEvent): string {
  return tuiRenderer.renderEventLine(ev);
}

/**
 * @beta
 * 渲染状态行（如「运行中 / 已暂停」）。
 */
export function renderStatusLine(status: string, detail?: string): string {
  return tuiRenderer.renderStatusLine(status, detail);
}

/**
 * @beta
 * 清行（用于进度刷新）。
 */
export function clearLine(): string {
  return tuiRenderer.clearLine();
}

/**
 * @beta
 * 提示符（用户输入行前缀）。
 */
export function prompt(prefix = 'you'): string {
  return tuiRenderer.prompt(prefix);
}

/**
 * @beta
 * 渲染工具参数渐进（#B3）：供 ConsoleLiveView / TUI 复用，带 ANSI 颜色 + 前缀。
 */
export function renderToolInputProgress(opts: {
  readonly name: string;
  readonly json: string;
}): string {
  return tuiRenderer.renderToolInputProgress(opts);
}

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
