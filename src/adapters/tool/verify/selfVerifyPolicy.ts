/**
 * 自验证回环策略（P3）：受控测试命令的取值与预算（值对象，构造后不可变）。
 *
 * 确定性触发器（缺一不可）：
 *  ① **仓库有测试症状** —— `<workspaceRoot>/package.json` 存在且含 `scripts.test`
 *     （`forWorkspace` 返回 `undefined`，即该仓库不启用）；
 *  ② **本回合确实改了源码** —— 由装配处注入的 `shouldVerify` 谓词判定
 *     （写类工具 + 源码扩展名，见 {@link isVerifiableTarget}）。
 *
 * 纪律（P3 原文要求）：**不进主门禁、可关、有超时与预算上限**——
 * 本策略把「跑命令」的全部预算（超时 / 输出上限 / 冷却 / 每会话次数 / 摘要行数）
 * 显式化为可注入字段，且默认全部保守。
 */
import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';

/** 策略的可选覆盖项（缺省取保守默认值）。 */
export interface SelfVerifyPolicyOptions {
  /** 测试命令（缺省 `npm test`）。 */
  readonly command?: string;
  /** 同一会话两次自验证之间的最小间隔（毫秒），防抖。 */
  readonly cooldownMs?: number;
  /** 同一会话最多触发的自验证次数（预算硬上限）。 */
  readonly maxRunsPerSession?: number;
  /** 单次测试命令超时（毫秒）。 */
  readonly timeoutMs?: number;
  /** 单路输出缓冲上限（字节）。 */
  readonly maxOutputBytes?: number;
  /** 回灌摘要的行数上限。 */
  readonly maxDigestLines?: number;
}

/**
 * 自验证策略（值对象）。
 */
export class SelfVerifyPolicy {
  /** 默认测试命令。 */
  public static readonly DEFAULT_COMMAND = 'npm test';

  /** 默认冷却时间（毫秒）：60s。 */
  public static readonly DEFAULT_COOLDOWN_MS = 60_000;

  /** 默认每会话触发上限。 */
  public static readonly DEFAULT_MAX_RUNS_PER_SESSION = 3;

  /** 默认超时（毫秒）：120s（受限：不超过两分钟）。 */
  public static readonly DEFAULT_TIMEOUT_MS = 120_000;

  /** 默认单路输出缓冲上限（字节）：256 KiB。 */
  public static readonly DEFAULT_MAX_OUTPUT_BYTES = 262_144;

  /** 默认摘要行数上限。 */
  public static readonly DEFAULT_MAX_DIGEST_LINES = 15;

  /** 可触发自验证的源码扩展名（写入目标须属此集合）。 */
  private static readonly SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
    '.ts',
    '.tsx',
    '.mts',
    '.cts',
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
    '.py',
    '.rs',
    '.go',
    '.java',
    '.rb',
    '.c',
    '.cc',
    '.cpp',
    '.h',
    '.hpp',
  ]);

  /** 测试命令。 */
  public readonly command: string;
  /** 冷却时间（毫秒）。 */
  public readonly cooldownMs: number;
  /** 每会话触发上限。 */
  public readonly maxRunsPerSession: number;
  /** 单次超时（毫秒）。 */
  public readonly timeoutMs: number;
  /** 单路输出上限（字节）。 */
  public readonly maxOutputBytes: number;
  /** 摘要行数上限。 */
  public readonly maxDigestLines: number;

  /**
   * @param options 已解析的策略取值（调用方保证全部非空）。
   */
  private constructor(options: Required<SelfVerifyPolicyOptions>) {
    this.command = options.command;
    this.cooldownMs = options.cooldownMs;
    this.maxRunsPerSession = options.maxRunsPerSession;
    this.timeoutMs = options.timeoutMs;
    this.maxOutputBytes = options.maxOutputBytes;
    this.maxDigestLines = options.maxDigestLines;
  }

  /**
   * 由可选覆盖项构造策略（缺省落保守默认值）。
   *
   * @param options 可选覆盖项。
   * @returns 策略值对象。
   */
  public static from(options: SelfVerifyPolicyOptions = {}): SelfVerifyPolicy {
    return new SelfVerifyPolicy({
      command: options.command ?? SelfVerifyPolicy.DEFAULT_COMMAND,
      cooldownMs: options.cooldownMs ?? SelfVerifyPolicy.DEFAULT_COOLDOWN_MS,
      maxRunsPerSession: options.maxRunsPerSession ?? SelfVerifyPolicy.DEFAULT_MAX_RUNS_PER_SESSION,
      timeoutMs: options.timeoutMs ?? SelfVerifyPolicy.DEFAULT_TIMEOUT_MS,
      maxOutputBytes: options.maxOutputBytes ?? SelfVerifyPolicy.DEFAULT_MAX_OUTPUT_BYTES,
      maxDigestLines: options.maxDigestLines ?? SelfVerifyPolicy.DEFAULT_MAX_DIGEST_LINES,
    });
  }

  /**
   * 针对某个工作区解析策略：**仅当仓库有测试症状**（`package.json` 含 `scripts.test`）
   * 时返回策略，否则返回 `undefined`（确定性触发器之一）。
   *
   * @param workspaceRoot 仓库根目录。
   * @param options 可选覆盖项。
   * @returns 策略；仓库无测试脚本或读取失败时为 `undefined`（fail-closed，不启用）。
   */
  public static forWorkspace(
    workspaceRoot: string,
    options: SelfVerifyPolicyOptions = {},
  ): SelfVerifyPolicy | undefined {
    if (!SelfVerifyPolicy.hasTestScript(workspaceRoot)) {
      return undefined;
    }
    return SelfVerifyPolicy.from(options);
  }

  /**
   * 该路径是否属「可验证目标」（源码扩展名）。
   *
   * @param path 写入目标路径（可为相对或绝对路径）。
   * @returns 扩展名属源码集合时为 true。
   */
  public static isVerifiableTarget(path: string): boolean {
    const ext = extname(path).toLowerCase();
    return ext !== '' && SelfVerifyPolicy.SOURCE_EXTENSIONS.has(ext);
  }

  /**
   * 读取 `<workspaceRoot>/package.json` 并判断是否声明了 `scripts.test`。
   *
   * @param workspaceRoot 仓库根目录。
   * @returns 存在测试脚本时为 true；文件缺失 / 解析失败 / 无脚本时为 false（不抛错）。
   */
  private static hasTestScript(workspaceRoot: string): boolean {
    if (workspaceRoot.trim() === '') {
      return false;
    }
    try {
      const raw = readFileSync(join(workspaceRoot, 'package.json'), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || !('scripts' in parsed)) {
        return false;
      }
      const scripts = (parsed as { scripts?: unknown }).scripts;
      if (typeof scripts !== 'object' || scripts === null) {
        return false;
      }
      const test = (scripts as Record<string, unknown>)['test'];
      return typeof test === 'string' && test.trim() !== '';
    } catch {
      return false;
    }
  }
}
