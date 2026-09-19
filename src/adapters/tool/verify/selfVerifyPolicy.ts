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

  /** 定向测试时最多收窄到的文件数（命令行长度的隐式上界）。 */
  private static readonly MAX_TARGETS = 8;

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
   * 定向测试：把「上次跑挂的文件」收窄进命令，跑失败的那批而不是全量（P1-⑨ 后半）。
   *
   * 为什么只对 `npm test` 形态生效：定向能力依赖该仓库的测试运行器支持「收窄到文件」的
   * 参数约定（npm 的 `--` 透传是事实标准：`npm test -- path/to/x.test.ts`）。
   * 对**任意自定义命令**做字符串拼接属于猜测，宁可退回全量命令（`this.command`），
   * 也不生成一条跑不起来的命令——错误的定向比不定向更贵。
   *
   * 为什么还要再过一层 {@link isTestPath}：堆栈帧多数指向**被测源码**，
   * 把 `src/core/foo.ts` 透传给运行器会被判成「没有匹配的测试」而**假失败**；
   * 假失败比不做定向更贵（模型会去追一个并不存在的回归）。
   *
   * @param files 上次失败输出里解析到的文件清单（可为空，可含非测试文件）。
   * @returns 定向命令；无测试文件、命令形态不支持收窄时返回原 `command`。
   */
  public narrowedCommand(files: readonly string[]): string {
    if (!/^npm (?:run )?test(?:\s|$)/.test(this.command)) {
      return this.command;
    }
    const targets = files
      .map((file) => file.trim())
      .filter((file) => file !== '' && SelfVerifyPolicy.isTestPath(file))
      .slice(0, SelfVerifyPolicy.MAX_TARGETS);
    return targets.length === 0 ? this.command : `${this.command} -- ${targets.join(' ')}`;
  }

  /**
   * 该路径是否像**测试文件**（定向测试只接受测试文件）。
   *
   * 覆盖常见命名约定：`x.test.ts` / `x.spec.tsx` / `test_x.py` / `x_test.go` / `FooTest.java`。
   * 刻意保守——认不出来就不定向（退回全量），不在命名约定上冒险。
   *
   * @param file 路径（相对或绝对，可含 `\`）。
   * @returns 形如测试文件时为 true。
   */
  private static isTestPath(file: string): boolean {
    const base = file.split(/[\\/]/).pop() ?? '';
    return (
      /\.(?:test|spec)\.[a-z0-9]+$/i.test(base) ||
      /^test_.*\.(?:py|rb)$/i.test(base) ||
      /_test\.(?:go|rb)$/i.test(base) ||
      /tests?\.java$/i.test(base)
    );
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
