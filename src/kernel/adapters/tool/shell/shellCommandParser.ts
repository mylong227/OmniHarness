/**
 * shell 命令结构化解析（A3 工具层纵深第一环）。
 *
 * 设计口径（为什么不直接把命令降级为 argv 数组）：
 * `shell` 工具的**对外契约**明确包含管道与重定向（见 `tests/unit/shellTool.test.ts`
 * 「shell 语义是工具契约的一部分，不可退化为 argv 数组」），因此本解析器不改变执行形态，
 * 而是把命令**结构化**出来，供上层策略裁决：段、程序名、重定向、命令替换、串联。
 *
 * fail-closed：凡是**无法可靠判定**的命令（引号未闭合、空命令段、以分隔符结尾、含 NUL）
 * 一律返回 `ok:false`，由调用方决定拒绝还是仅记录——绝不「猜一个能跑的形态」。
 */

/** 命令结构化解析结果。 */
export interface ShellCommandPlan {
  /** 顶层命令段（按 `|` / `&&` / `||` / `;` / 换行 切分，均已去除首尾空白）。 */
  readonly segments: readonly string[];
  /** 各命令段的首个可执行程序名（已剥离前置 `NAME=VALUE` 环境变量赋值）。 */
  readonly programs: readonly string[];
  /** 是否含命令替换（`$(` 或反引号）——把数据变成命令的经典注入构造。 */
  readonly hasSubstitution: boolean;
  /** 是否含重定向（`>` / `>>` / `<` / `2>` / `&>` 等）。 */
  readonly hasRedirection: boolean;
  /** 是否含命令串联（`;` / `&&` / `||`）。 */
  readonly hasChaining: boolean;
}

/** 解析成败（判别联合，失败必带原因，便于 fail-closed 拒绝与审计留痕）。 */
export type ShellParseOutcome =
  | { readonly ok: true; readonly plan: ShellCommandPlan }
  | { readonly ok: false; readonly reason: string };

/** 单次扫描的中间状态（可变容器，仅在 {@link ShellCommandParser.parse} 内短生命周期使用）。 */
interface ScanState {
  /** 已闭合的命令段。 */
  segments: string[];
  /** 当前段缓冲。 */
  buffer: string;
  /** 是否出现命令替换。 */
  hasSubstitution: boolean;
  /** 是否出现重定向。 */
  hasRedirection: boolean;
  /** 是否出现命令串联。 */
  hasChaining: boolean;
  /** 首个致死原因（fail-closed）。 */
  failure: string | undefined;
}

/** 环境变量赋值前缀：`NAME=VALUE`（仅用于剥离，不影响语义）。 */
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * shell 命令解析器：把命令文本解析为 {@link ShellCommandPlan}，不可判定即 fail-closed。
 */
export class ShellCommandParser {
  /**
   * 解析一条命令。
   *
   * @param command 待解析的命令文本（调用方已 trim）。
   * @returns 解析结果：可判定时附结构化计划；不可判定时 `ok:false` 并给出原因。
   */
  public parse(command: string): ShellParseOutcome {
    if (command.includes('\u0000')) {
      return { ok: false, reason: '命令包含 NUL 字符' };
    }
    const state: ScanState = {
      segments: [],
      buffer: '',
      hasSubstitution: false,
      hasRedirection: false,
      hasChaining: false,
      failure: undefined,
    };
    this.scan(command, state);
    if (state.failure !== undefined) {
      return { ok: false, reason: state.failure };
    }
    const segments = this.finishSegment(state, true);
    if (typeof segments === 'string') {
      return { ok: false, reason: segments };
    }
    const programs: string[] = [];
    for (const segment of segments) {
      const program = this.programOf(segment);
      if (program === '') {
        return { ok: false, reason: `命令段无可执行程序：${segment}` };
      }
      programs.push(program);
    }
    return {
      ok: true,
      plan: {
        segments,
        programs,
        hasSubstitution: state.hasSubstitution,
        hasRedirection: state.hasRedirection,
        hasChaining: state.hasChaining,
      },
    };
  }

  /**
   * 单遍字符扫描：按引号/转义状态在顶层切段，并标记替换/重定向/串联。
   *
   * 引号状态直接记录**引号字符本身**（`'` / `"`，空串表示不在引号内），
   * 避免「引号类型标签」与字符比较错位导致闭合判定永不成立。
   *
   * @param command 命令文本。
   * @param state 就地累积的扫描状态。
   * @returns 无返回值（结果写入 state）。
   */
  private scan(command: string, state: ScanState): void {
    let quote = '';
    let escaped = false;
    let parenDepth = 0;
    for (let i = 0; i < command.length; i += 1) {
      const ch = command.charAt(i);
      if (state.failure !== undefined) {
        return;
      }
      if (escaped) {
        state.buffer += ch;
        escaped = false;
        continue;
      }
      if (ch === '\\' && quote !== "'") {
        state.buffer += ch;
        escaped = true;
        continue;
      }
      if (quote !== '') {
        if (ch === quote) {
          quote = '';
        } else if (this.isSubstitutionAt(command, i, quote)) {
          state.hasSubstitution = true;
        }
        state.buffer += ch;
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        state.buffer += ch;
        continue;
      }
      if (this.isSubstitutionAt(command, i, quote)) {
        state.hasSubstitution = true;
        state.buffer += ch;
        continue;
      }
      if (ch === '(') {
        parenDepth += 1;
        state.buffer += ch;
        continue;
      }
      if (ch === ')') {
        parenDepth = Math.max(0, parenDepth - 1);
        state.buffer += ch;
        continue;
      }
      if (parenDepth === 0 && (ch === '<' || ch === '>')) {
        state.hasRedirection = true;
        state.buffer += ch;
        continue;
      }
      if (parenDepth === 0 && this.isSeparator(command, i, ch)) {
        const closed = this.finishSegment(state, false);
        if (typeof closed === 'string') {
          state.failure = closed;
          return;
        }
        i = this.skipSeparator(command, i, ch, state);
        continue;
      }
      state.buffer += ch;
    }
    if (quote !== '') {
      state.failure = `引号未闭合（${quote === "'" ? '单引号' : '双引号'}）`;
    }
  }

  /**
   * 判断当前位置是否构成命令替换：`$(`（引号内亦可）或反引号（**单引号内不算**）。
   *
   * @param command 命令文本。
   * @param index 当前下标。
   * @param quote 当前引号状态（空串表示不在引号内）。
   * @returns 构成命令替换时为 true。
   */
  private isSubstitutionAt(command: string, index: number, quote: string): boolean {
    const ch = command.charAt(index);
    if (ch === '`') {
      return quote !== "'";
    }
    return ch === '$' && command.charAt(index + 1) === '(';
  }

  /**
   * 判断当前位置是否为顶层分隔符。
   *
   * @param command 命令文本。
   * @param index 当前位置下标。
   * @param ch 当前字符。
   * @returns 命中 `|` / `&&` / `;` / 换行 时为 true；单独 `&` 不计入（后台符不做契约承诺）。
   */
  private isSeparator(command: string, index: number, ch: string): boolean {
    if (ch === '|' || ch === ';' || ch === '\n' || ch === '\r') {
      return true;
    }
    return ch === '&' && command.charAt(index + 1) === '&';
  }

  /**
   * 跳过分隔符并标记串联/管道语义。
   *
   * @param command 命令文本。
   * @param index 分隔符起始下标。
   * @param ch 分隔符首字符。
   * @param state 扫描状态（写入 hasChaining）。
   * @returns 分隔符最后一个字符的下标。
   */
  private skipSeparator(command: string, index: number, ch: string, state: ScanState): number {
    if (ch === '&') {
      state.hasChaining = true;
      return index + 1;
    }
    if (ch === ';') {
      state.hasChaining = true;
    }
    if (ch === '|' && command.charAt(index + 1) === '|') {
      state.hasChaining = true;
      return index + 1;
    }
    return index;
  }

  /**
   * 收尾当前段：空段即 fail-closed（含命令以分隔符结尾的情形）。
   *
   * @param state 扫描状态。
   * @param last 是否为最后一段（最后一段为空表示命令以分隔符结尾）。
   * @returns 全部段（成功）或错误原因（字符串，失败）。
   */
  private finishSegment(state: ScanState, last: boolean): string[] | string {
    const segment = state.buffer.trim();
    state.buffer = '';
    if (segment === '') {
      if (state.segments.length === 0 && last) {
        return '命令为空';
      }
      return last ? '命令以分隔符结尾' : '存在空命令段（相邻分隔符）';
    }
    state.segments.push(segment);
    return state.segments;
  }

  /**
   * 取命令段的首个词（程序名），并按需剥离前置环境变量赋值。
   *
   * @param segment 命令段文本。
   * @returns 程序名（去引号）；无法取得时为空串。
   */
  private programOf(segment: string): string {
    let head = segment;
    while (ENV_ASSIGN.test(head)) {
      const space = head.search(/\s/);
      if (space < 0) {
        return '';
      }
      head = head.slice(space).trimStart();
    }
    return this.stripQuotes(this.firstToken(head));
  }

  /**
   * 读取首个空白分隔的词（保留引号内容，供后续去引号）。
   *
   * @param text 文本。
   * @returns 首个词（无词时为空串）。
   */
  private firstToken(text: string): string {
    let quote = '';
    let escaped = false;
    let out = '';
    for (const ch of text) {
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === '\\' && quote !== "'") {
        out += ch;
        escaped = true;
        continue;
      }
      if (quote !== '') {
        if (ch === quote) {
          quote = '';
        }
        out += ch;
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        out += ch;
        continue;
      }
      if (/\s/.test(ch)) {
        break;
      }
      out += ch;
    }
    return out;
  }

  /**
   * 去掉包裹 token 的一层引号。
   *
   * @param token 原始 token。
   * @returns 去引号后的文本。
   */
  private stripQuotes(token: string): string {
    const quote = token.charAt(0);
    if (token.length >= 2 && (quote === '"' || quote === "'") && token.endsWith(quote)) {
      return token.slice(1, -1);
    }
    return token;
  }
}
