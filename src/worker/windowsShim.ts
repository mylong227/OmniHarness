import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, resolve } from 'node:path';

/** 解析结果：可直接 spawn 的宿主命令 + 需要前置的参数。 */
export interface WindowsShimCommand {
  /** 实际可执行文件（node 或 .exe 绝对路径）。 */
  readonly command: string;
  /** 前置参数（通常是 npm 包的 JS 入口）。 */
  readonly argsPrefix: readonly string[];
}

/**
 * Windows 命令解析（把 npm `.cmd` 垫片还原为 `node <entry.js>`）。
 *
 * 为什么必须做：`CliWorker` 原先把 `shell:true` 的 argv 交给 cmd，模型可控的 task 里一个
 * `&` 就能执行第二条命令（2026-10-18 审查 P0）。直接 `spawn(.cmd, …, {shell:false})` 又会
 * EINVAL；因此解析 npm 垫片、绕过 cmd 是唯一既不注入也不破坏本实现类 CLI 的路径。
 *
 * 解析只支持**可证明的形态**：`SET "VAR=%~dp0\..."` + 最后一行 `"%NODE%" "%ENTRY%" %*`。
 * 认不出就返回 undefined / `isBatch` 为 true，由调用方 fail-closed。
 */
export class WindowsShim {
  /** 同一命令只解析一次（解析失败也缓存，避免每次 spawn 都起 where.exe）。 */
  private static readonly cache = new Map<string, WindowsShimCommand | null>();

  /**
   * 解析命令；非 Windows / 非 .cmd 垫片时返回 undefined。
   * @param command 原始命令（裸名或路径）
   * @returns 可安全 spawn 的命令；无法解析时为 undefined
   */
  public static resolve(command: string): WindowsShimCommand | undefined {
    if (process.platform !== 'win32') return undefined;
    const cached = WindowsShim.cache.get(command);
    if (cached !== undefined) return cached ?? undefined;
    const resolved = WindowsShim.resolveUncached(command);
    WindowsShim.cache.set(command, resolved ?? null);
    return resolved;
  }

  /**
   * 命令是否解析到 `.cmd`/`.bat`（用于“无法安全解析”时 fail-closed）。
   * @param command 原始命令
   * @returns 是批处理垫片时为 true
   */
  public static isBatch(command: string): boolean {
    if (process.platform !== 'win32') return false;
    const file = WindowsShim.locate(command);
    if (file === undefined) return false;
    const ext = extname(file).toLowerCase();
    return ext === '.cmd' || ext === '.bat';
  }

  /**
   * 实际解析。
   * @param command 原始命令
   * @returns 可 spawn 的命令或 undefined
   */
  private static resolveUncached(command: string): WindowsShimCommand | undefined {
    const file = WindowsShim.locate(command);
    if (file === undefined) return undefined;
    const ext = extname(file).toLowerCase();
    if (ext === '.exe' || ext === '.com') {
      return { command: file, argsPrefix: [] };
    }
    if (ext !== '.cmd' && ext !== '.bat') return undefined;
    const entry = WindowsShim.entryOf(file);
    if (entry === undefined) return undefined;
    return { command: process.execPath, argsPrefix: [entry] };
  }

  /**
   * 定位命令文件（裸名经 `where.exe`，路径直接判断存在）。
   * @param command 原始命令
   * @returns 绝对路径或 undefined
   */
  private static locate(command: string): string | undefined {
    if (existsSync(command)) return resolve(command);
    try {
      const out = execFileSync('where.exe', [command], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
      });
      const files = out
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .filter((line) => ['.exe', '.cmd', '.bat', '.com'].includes(extname(line).toLowerCase()));
      // 优先真实可执行文件，其次 cmd 垫片（npm 同时提供 .cmd/.ps1）。
      return (
        files.find((file) => ['.exe', '.com'].includes(extname(file).toLowerCase())) ?? files[0]
      );
    } catch {
      return undefined;
    }
  }

  /**
   * 从 npm `.cmd` 垫片里解析 JS 入口。
   * @param shimPath 垫片绝对路径
   * @returns JS 入口绝对路径或 undefined
   */
  private static entryOf(shimPath: string): string | undefined {
    let text: string;
    try {
      text = readFileSync(shimPath, 'utf8');
    } catch {
      return undefined;
    }
    const base = dirname(shimPath);
    const vars = new Map<string, string>();
    for (const match of text.matchAll(/^\s*SET\s+"([^"=]+)=([^"]*)"\s*$/gim)) {
      const name = match[1]?.trim().toUpperCase();
      const value = match[2];
      if (name === undefined || value === undefined) continue;
      const expanded = value.replace(/%~dp0/giu, `${base}\\`).replace(/%dp0%/giu, `${base}\\`);
      vars.set(name, expanded);
    }
    // 最后一行带 `%*` 的调用才是真正的入口（前面的 FOR/IF 只是探测前缀）。
    const callLine = text
      .split(/\r?\n/u)
      .reverse()
      .find((line) => line.includes('%*') && !/^\s*(?:FOR|IF)\b/iu.test(line.trim()));
    if (callLine === undefined) return undefined;
    const expandedLine = callLine.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/gu, (_all, name: string) => {
      return vars.get(name.toUpperCase()) ?? '';
    });
    const quoted = [...expandedLine.matchAll(/"([^"]+)"/gu)]
      .map((m) => m[1] ?? '')
      .filter((token) => token !== '');
    const entry = quoted.find((token) => /\.(?:c|m)?js$/iu.test(token));
    if (entry === undefined) return undefined;
    const absolute = isAbsolute(entry) ? entry : resolve(base, entry);
    return existsSync(absolute) ? absolute : undefined;
  }
}
