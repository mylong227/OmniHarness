import { at } from './arrayAt.js';
/**
 * 命令规范化（对标 codex `command_canonicalization.rs`）。
 *
 * 目的：把「同一语义、不同包装」的命令映射到同一个 canonical token 序列，
 * 使审批缓存键不受 `bash -lc "x"` 与 `bash -c "x"` 这类包装差异影响。
 * 纯函数、零依赖，不会执行命令，也不解析 shell 语法（无法安全拆分的脚本整体降级为标记 + 原文）。
 */

/** 降级标记：shell 脚本含多条命令/管道，无法归约为单条命令 token 序列。 */
export const SHELL_SCRIPT_MARKER = '__shell_script__';

/** 降级标记：PowerShell 脚本（不做 PS 语法解析，整体保留）。 */
export const POWERSHELL_SCRIPT_MARKER = '__powershell_script__';

/** 降级标记：cmd 脚本（不做 cmd 语法解析，整体保留）。 */
export const CMD_SCRIPT_MARKER = '__cmd_script__';

/** 已知 POSIX shell 可执行名（比较前已取 basename 并去 .exe）。 */
const SHELLS: ReadonlySet<string> = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish']);

/** 会把后续内容视作脚本的 shell 开关。 */
const SHELL_SCRIPT_FLAGS: ReadonlySet<string> = new Set(['-c', '-lc', '-cl']);

/** 拆分归并符：出现任一即说明不是单条简单命令，不可安全去包装。 */
const COMPOUND_PATTERN = /&&|\|\||[|;&\n]/;

/**
 * 命令规范化器。
 *
 * 无状态、无 IO：同一实例可并发复用（默认实例见文件末尾组合根门面）。
 * `OOP 收口`（2026-09-11）：原静态方法族改为实例方法，消除 `static`。
 */
export class CommandCanonicalizer {
  /**
   * shell 词法切分：按空白分词，处理单/双引号与反斜杠转义。
   * 引号本身不保留，只保留其内容——保证「加不加引号」不改变 canonical 结果。
   */
  public tokenizeShell(input: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let opened = false;
    let quote: '"' | "'" | undefined;
    for (let i = 0; i < input.length; i += 1) {
      const ch = at(input, i);
      if (quote !== undefined) {
        if (ch === quote) {
          quote = undefined;
        } else {
          current += ch;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        opened = true;
        continue;
      }
      if (ch === '\\' && i + 1 < input.length) {
        current += at(input, i + 1);
        i += 1;
        opened = true;
        continue;
      }
      if (this.isWhitespace(ch)) {
        if (opened || current !== '') {
          tokens.push(current);
          current = '';
          opened = false;
        }
        continue;
      }
      current += ch;
    }
    if (opened || current !== '') {
      tokens.push(current);
    }
    return tokens;
  }

  /**
   * 规范化命令：成功去包装时返回内层命令 token 序列；无法安全拆分时返回 `[标记, 原文]`。
   * 空输入返回空数组，调用方应视为「无可审批目标」。
   */
  public canonicalizeCommand(command: string): string[] {
    const raw = command.trim();
    if (raw === '') {
      return [];
    }
    const tokens = this.tokenizeShell(raw);
    const powershell = this.extractPowerShellScript(tokens);
    if (powershell !== undefined) {
      return [POWERSHELL_SCRIPT_MARKER, powershell];
    }
    const cmd = this.extractCmdScript(tokens);
    if (cmd !== undefined) {
      return [CMD_SCRIPT_MARKER, cmd];
    }
    const shell = this.extractShellScript(tokens);
    if (shell !== undefined) {
      const inner = shell.script.trim();
      // 仅内层为单条简单命令时才去包装；含管道/串联时保留脚本原文，避免误归并语义不同的命令。
      if (inner !== '' && !COMPOUND_PATTERN.test(inner)) {
        return this.tokenizeShell(inner);
      }
      return [SHELL_SCRIPT_MARKER, shell.shell, inner];
    }
    return tokens;
  }

  /** 规范化结果的稳定字符串表示（供审批缓存键使用）。 */
  public canonicalKeyOf(tokens: readonly string[]): string {
    return tokens.join(' ');
  }

  /** 单字符是否为分词空白。 */
  private isWhitespace(ch: string): boolean {
    return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
  }

  /** 取可执行名：去目录前缀、去 .exe 后缀、转小写（跨平台一致）。 */
  private basenameOf(program: string): string {
    const last = program.split(/[\\/]/).at(-1) ?? program;
    return last.toLowerCase().replace(/\.exe$/, '');
  }

  /** 提取 `bash -lc "script"` 形态（tokens 长度 ≥3，末尾为脚本）。 */
  private extractShellScript(
    tokens: readonly string[],
  ): { shell: string; script: string } | undefined {
    if (tokens.length < 3) {
      return undefined;
    }
    const shell = this.basenameOf(at(tokens, 0));
    if (!SHELLS.has(shell)) {
      return undefined;
    }
    const flags = tokens.slice(1, -1);
    if (!flags.some((flag) => SHELL_SCRIPT_FLAGS.has(flag))) {
      return undefined;
    }
    return { shell, script: at(tokens, tokens.length - 1) };
  }

  /** 提取 `powershell -Command "script"` 形态（-EncodedCommand 无法规范化，按原文降级）。 */
  private extractPowerShellScript(tokens: readonly string[]): string | undefined {
    if (tokens.length < 2) {
      return undefined;
    }
    const program = this.basenameOf(at(tokens, 0));
    if (program !== 'powershell' && program !== 'pwsh') {
      return undefined;
    }
    for (let i = 1; i < tokens.length; i += 1) {
      const flag = at(tokens, i).toLowerCase();
      if (flag === '-encodedcommand') {
        return undefined;
      }
      if (flag === '-command' || flag === '-c') {
        const rest = tokens.slice(i + 1).join(' ');
        return rest === '' ? undefined : rest;
      }
    }
    return undefined;
  }

  /** 提取 `cmd /c "script"` 形态（`/c` 与 `/k` 之后整体为脚本，跳过 `/d` `/s` 等开关）。 */
  private extractCmdScript(tokens: readonly string[]): string | undefined {
    if (tokens.length < 2) {
      return undefined;
    }
    if (this.basenameOf(at(tokens, 0)) !== 'cmd') {
      return undefined;
    }
    for (let i = 1; i < tokens.length; i += 1) {
      const flag = at(tokens, i).toLowerCase();
      if (flag === '/c' || flag === '/k') {
        const rest = tokens.slice(i + 1).join(' ');
        return rest === '' ? undefined : rest;
      }
    }
    return undefined;
  }
}

// ---- 门面兼容：保留原导出名，委托默认实例 ----
const commandCanonicalizer = new CommandCanonicalizer();

/**
 * shell 词法切分：按空白分词，处理单/双引号与反斜杠转义。
 * 引号本身不保留，只保留其内容——保证「加不加引号」不改变 canonical 结果。
 */
export function tokenizeShell(input: string): string[] {
  return commandCanonicalizer.tokenizeShell(input);
}

/**
 * 规范化命令：成功去包装时返回内层命令 token 序列；无法安全拆分时返回 `[标记, 原文]`。
 * 空输入返回空数组，调用方应视为「无可审批目标」。
 */
export function canonicalizeCommand(command: string): string[] {
  return commandCanonicalizer.canonicalizeCommand(command);
}

/** 规范化结果的稳定字符串表示（供审批缓存键使用）。 */
export function canonicalKeyOf(tokens: readonly string[]): string {
  return commandCanonicalizer.canonicalKeyOf(tokens);
}
