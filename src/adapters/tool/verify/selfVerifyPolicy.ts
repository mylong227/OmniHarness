/**
 * 自验证回环策略（P3）：受控测试命令的取值与预算（值对象，构造后不可变）。
 *
 * 确定性触发器（缺一不可）：
 *  ① **仓库有测试症状** —— 由 {@link SelfVerifyCommandDetector} 从仓库证据推断出测试命令
 *     （`package.json#scripts.test` / pytest 配置 / `Cargo.toml` / `go.mod` / `pom.xml` /
 *     gradle / rspec / `*.sln` / `Makefile#test`）；探测不到则不启用，返回 `undefined`。
 *     **显式传入的 `command` 直接生效，不再受「有没有测试症状」这道闸门约束**——用户给出
 *     的命令是最强证据，原实现把它挡在闸门之外属「声明未接线」（2026-09-19 修正）。
 *  ② **本回合确实改了源码** —— 由装配处注入的 `shouldVerify` 谓词判定
 *     （写类工具 + 源码扩展名，见 {@link SelfVerifyPolicy.isVerifiableTarget}）。
 *
 * 纪律（P3 原文要求）：**不进主门禁、可关、有超时与预算上限**——
 * 本策略把「跑命令」的全部预算（超时 / 输出上限 / 冷却 / 每会话次数 / 摘要行数）
 * 显式化为可注入字段，且默认全部保守。
 *
 * 职责边界：本类只持**取值与预算**；命令探测交给 `SelfVerifyCommandDetector`，
 * 定向收窄交给 `TestCommandNarrower`（各自一类、各自可单测）。
 */
import { extname } from 'node:path';
import { SelfVerifyCommandDetector } from './selfVerifyCommandDetector.js';
import { TestCommandNarrower } from './testCommandNarrower.js';

/** 策略的可选覆盖项（缺省取保守默认值）。 */
export interface SelfVerifyPolicyOptions {
  /**
   * 测试命令。**显式给出即视为「用户已确认该命令可跑」**，跳过测试症状探测；
   * 缺省时由 `SelfVerifyCommandDetector` 从工作区证据推断。
   */
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
  /** 默认测试命令（探测不到证据、又未显式给出时的兜底取值）。 */
  public static readonly DEFAULT_COMMAND = 'npm test';

  /** 默认冷却时间（毫秒）：60s。 */
  public static readonly DEFAULT_COOLDOWN_MS = 60_000;

  /** 默认每会话触发上限。 */
  public static readonly DEFAULT_MAX_RUNS_PER_SESSION = 3;

  /**
   * 默认超时（毫秒）：**300 秒**。
   *
   * 口径更正（2026-09-26 审计 A3）：原为 120 秒并注明「受限：不超过两分钟」，但对**带构建步骤**
   * 的测试命令（本仓 `npm test` = `npm run build && node --test …`）两分钟根本不够 —— 实测结果是
   * 自验证**首次触发即超时**，每会话 3 次预算被白烧，功能形同不存在。300 秒覆盖「构建 + 单测」这一
   * 最常见组合，同时仍受 `maxRunsPerSession`（3 次）约束，最坏耗时可控。
   * 需要更长/更短可用 `selfVerify.timeoutMs` 或环境变量 {@link SelfVerifyPolicy.TIMEOUT_ENV_KEY}。
   */
  public static readonly DEFAULT_TIMEOUT_MS = 300_000;

  /** 覆盖自验证超时的环境变量名（取值须为正有限数，否则回落默认）。 */
  public static readonly TIMEOUT_ENV_KEY = 'OMNI_SELF_VERIFY_TIMEOUT_MS';

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
    '.kt',
    '.cs',
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
   * 注意：本方法**不做**测试症状判定（那是 `forWorkspace` 的职责）——直接调用它
   * 等于「调用方已确认要跑」，命令缺省时用 {@link SelfVerifyPolicy.DEFAULT_COMMAND}。
   *
   * @param options 可选覆盖项。
   * @returns 策略值对象。
   */
  public static from(options: SelfVerifyPolicyOptions = {}): SelfVerifyPolicy {
    const explicit = options.command?.trim();
    return new SelfVerifyPolicy({
      command:
        explicit !== undefined && explicit !== '' ? explicit : SelfVerifyPolicy.DEFAULT_COMMAND,
      cooldownMs: options.cooldownMs ?? SelfVerifyPolicy.DEFAULT_COOLDOWN_MS,
      maxRunsPerSession: options.maxRunsPerSession ?? SelfVerifyPolicy.DEFAULT_MAX_RUNS_PER_SESSION,
      timeoutMs: options.timeoutMs ?? SelfVerifyPolicy.resolveTimeoutMs(),
      maxOutputBytes: options.maxOutputBytes ?? SelfVerifyPolicy.DEFAULT_MAX_OUTPUT_BYTES,
      maxDigestLines: options.maxDigestLines ?? SelfVerifyPolicy.DEFAULT_MAX_DIGEST_LINES,
    });
  }

  /**
   * 解析生效的自验证超时（毫秒）：环境变量 > 库级默认；非法值回落默认（不静默变 NaN）。
   *
   * 为什么要给一个 env 出口（2026-09-26 审计 A3）：`DEFAULT_TIMEOUT_MS` 对**带构建步骤**的
   * 测试命令偏小（本仓 `npm test` = `npm run build && node --test …`，实测数分钟），于是自验证
   * 首次触发即超时、每会话 3 次预算随即耗尽——看起来「开了」，实际什么都没验证到。
   * 配置层 `selfVerify.timeoutMs` 早已可覆盖，但对只想临时放大的使用者来说改配置文件太重。
   * @returns 生效的超时毫秒数（严格正有限数，否则默认）。
   */
  public static resolveTimeoutMs(): number {
    const raw = process.env[SelfVerifyPolicy.TIMEOUT_ENV_KEY];
    if (raw !== undefined && raw.trim() !== '') {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed > 0) {
        return Math.floor(parsed);
      }
    }
    return SelfVerifyPolicy.DEFAULT_TIMEOUT_MS;
  }

  /**
   * 针对某个工作区解析策略。
   *
   * 取值优先级（高 → 低）：
   *  ① `options.command` 显式给出 ⇒ **直接采用**（用户给的命令比任何推断都强）；
   *  ② 否则 {@link SelfVerifyCommandDetector.detect} 从仓库证据推断；
   *  ③ 都没有 ⇒ 返回 `undefined`（**不启用**，fail-closed）。
   *
   * @param workspaceRoot 仓库根目录。
   * @param options 可选覆盖项。
   * @returns 策略；显式命令缺失且仓库无测试症状时为 `undefined`（不启用）。
   */
  public static forWorkspace(
    workspaceRoot: string,
    options: SelfVerifyPolicyOptions = {},
  ): SelfVerifyPolicy | undefined {
    const explicit = options.command?.trim();
    if (explicit !== undefined && explicit !== '') {
      return SelfVerifyPolicy.from({ ...options, command: explicit });
    }
    const detected = SelfVerifyCommandDetector.detect(workspaceRoot);
    if (detected === undefined) {
      return undefined;
    }
    return SelfVerifyPolicy.from({ ...options, command: detected });
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
   * 定向测试：把「上次跑挂的文件」收窄进命令，跑失败的那批而不是全量。
   *
   * 实现委托给 {@link TestCommandNarrower}——它按运行器（npm / pytest / jest / rspec /
   * go / cargo / mvn / gradle / dotnet）各用**文档化的收窄参数**，且只接受**测试文件**
   * 作为目标（堆栈帧多指向被测源码，透传会假失败）。认不出的命令原样返回。
   *
   * @param files 上次失败输出里解析到的文件清单（可为空，可含非测试文件）。
   * @returns 定向命令；无测试文件、命令形态不支持收窄时返回原 `command`。
   */
  public narrowedCommand(files: readonly string[]): string {
    return TestCommandNarrower.narrow(this.command, files);
  }
}
