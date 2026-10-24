/**
 * 长任务评测契约（2026-10-24，P0-2）。
 *
 * 解决的问题：`harnessAb` 的内置任务只覆盖「写文件 + 读取确认」这类短任务；长时程能力
 * （结构化进度、收尾检查清单、跨 context window 的稳定状态）没有可机械验收的回归集。
 *
 * 本文件只放**纯逻辑/可复用件**（任务清单校验、口径汇总、隔离沙箱、验证执行、transcript、
 * CLI 参数与 skip 判定、自检），执行入口是 `tools/eval/longTasks.mjs`：
 *  - `pass@k` / `pass^k` / `tokensPerSolved` **直接复用** `src/eval/abMetrics.ts` 的 `AbMetrics`；
 *  - 每任务在**独立临时 git 仓库**里跑（fixture 复制，不污染仓库工作区）；
 *  - 任务 JSON 里必须有 `verifyCommand` 与 `expectedFiles`——没有机械验收不算成功；
 *  - 无凭据时 `LongTaskRunPlan.skipReason` 给出显式 skipped 理由，绝不 mock 冒充真实跑分。
 *
 * 诚实边界：20 个 fixture 是**本仓自建的合成任务**（不是 SWE-bench/Terminal-Bench 分数），
 * 用来做「harness 改动是否真的改变长任务表现」的回归判据；任务规模小于真实外部基准。
 */

import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { AbMetrics, type AbRun, type AbSummary } from './abMetrics.ts';
import { VerifyCommandRunner, type VerifyCommandOutcome } from '../util/verifyCommandRunner.ts';

/** 一个长任务定义（对应 `tools/eval/long-tasks/tasks/<id>.json`）。 */
export interface LongTaskSpec {
  /** 任务 id（同时是 fixture 目录名；`^[a-z0-9][a-z0-9-]{0,63}$`）。 */
  readonly id: string;
  /** 发给模型的提示（必须自带可机械验收的目标）。 */
  readonly prompt: string;
  /** fixture 仓库目录名（`tools/eval/long-tasks/fixtures/<repo>`）。 */
  readonly repo: string;
  /** 机械验收命令（在隔离仓库里执行；退出码 0 才算通过）。 */
  readonly verifyCommand: string;
  /** 必须存在的文件（相对隔离仓库根；存在性只是必要条件，行为由 verifyCommand 判定）。 */
  readonly expectedFiles: readonly string[];
  /** 单次运行的墙钟超时（毫秒）。 */
  readonly timeoutMs: number;
  /** 单次运行的 token 预算（透传 `--turn-token-budget`）。 */
  readonly maxTokens: number;
}

/** 任务校验结果。 */
export interface LongTaskValidation {
  /** 是否通过。 */
  readonly ok: boolean;
  /** 不通过原因（逐条可读）。 */
  readonly errors: readonly string[];
  /** 通过时的规范化任务；失败时 undefined。 */
  readonly spec: LongTaskSpec | undefined;
}

/** 单次长任务运行结果（`ok`/`tokens`/`wallMs` 满足 {@link AbRun}，可直接进 AbMetrics）。 */
export interface LongTaskRun extends AbRun {
  /** 模型 CLI 退出码（超时/无法启动时为 null）。 */
  readonly exitCode: number | null;
  /** 是否超时被终止。 */
  readonly timedOut: boolean;
  /** 独立验证命令是否通过。 */
  readonly verifyOk: boolean;
  /** `expectedFiles` 里缺失的文件。 */
  readonly missingFiles: readonly string[];
  /** 本次运行的 transcript 绝对路径。 */
  readonly transcript: string;
}

/** 单任务汇总（口径来自 AbMetrics，不复制公式）。 */
export interface LongTaskTaskSummary {
  /** 任务 id。 */
  readonly id: string;
  /** k 次运行。 */
  readonly runs: readonly LongTaskRun[];
  /** 复用 AbMetrics 的汇总（pass@k / pass^k / tokensPerSolved）。 */
  readonly summary: AbSummary;
}

/** 任务集汇总。 */
export interface LongTaskAggregate {
  /** 任务数。 */
  readonly tasks: number;
  /** 总运行次数。 */
  readonly runs: number;
  /** 成功次数。 */
  readonly successes: number;
  /** pass@1：单次尝试成功率（successes / runs；0 次运行时为 0）。 */
  readonly passAt1: number;
  /** 任务级 pass@k：至少一次成功的任务占比。 */
  readonly passAtK: number;
  /** 任务级 pass^k：k 次全成功的任务占比。 */
  readonly passAllK: number;
  /** 总 token。 */
  readonly tokens: number;
  /** 每成功一次的 token（无成功/无 usage 为 null）。 */
  readonly tokensPerSolved: number | null;
  /** 总墙钟毫秒。 */
  readonly wallMs: number;
}

/** 验证执行结果（在通用命令结果上补充命令文本）。 */
export interface LongTaskVerifyResult extends VerifyCommandOutcome {
  /** 实际执行的命令。 */
  readonly command: string;
}

/** 沙箱构造参数。 */
export interface LongTaskSandboxOptions {
  /** 任务定义。 */
  readonly spec: LongTaskSpec;
  /** fixture 根目录（`tools/eval/long-tasks/fixtures`）。 */
  readonly fixturesRoot: string;
  /** 临时仓库的父目录（每次运行在其下 mkdtemp）。 */
  readonly rootDir: string;
}

/** CLI 选项。 */
export interface LongTaskCliOptions {
  /** 每任务运行次数（k）。 */
  readonly k: number;
  /** 只打印计划，不调模型。 */
  readonly dryRun: boolean;
  /** 自检：fixture + 参考解 + 验证器（不调模型、不需要 key）。 */
  readonly selfCheck: boolean;
  /** 是否给 CLI 打开长时程协议（`OMNI_LONG_HORIZON=1` 等）。 */
  readonly longHorizon: boolean;
  /** 模型名（透传 CLI `--model`；缺省不覆盖）。 */
  readonly model: string | undefined;
  /** 任务目录（含 tasks/fixtures/verifiers/solutions）。 */
  readonly tasksDir: string;
  /** 报告输出文件（缺省 stdout）。 */
  readonly out: string | undefined;
  /** transcript 输出目录（缺省临时目录）。 */
  readonly transcriptsDir: string | undefined;
  /** 只跑这些任务 id（缺省全部）。 */
  readonly only: readonly string[] | undefined;
}

/** 自检单任务结果。 */
export interface LongTaskSelfCheckItem {
  /** 任务 id。 */
  readonly id: string;
  /** 参考解是否通过验证器。 */
  readonly ok: boolean;
  /** 失败原因（通过时为 `ok`）。 */
  readonly detail: string;
}

/** 自检报告。 */
export interface LongTaskSelfCheckReport {
  /** 全部通过为 true。 */
  readonly ok: boolean;
  /** 通过任务数。 */
  readonly passed: number;
  /** 失败任务数。 */
  readonly failed: number;
  /** 逐任务结果。 */
  readonly items: readonly LongTaskSelfCheckItem[];
}

/** 任务 id / repo 的合法形态（同时作为目录名与 slug，拒绝路径穿越）。 */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
/** 单次超时下限/上限（防止 0 超时或无限挂起）。 */
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 30 * 60_000;
/** token 预算下限/上限。 */
const MIN_MAX_TOKENS = 1_000;
const MAX_MAX_TOKENS = 10_000_000;
/** 验证输出上限（字节）。 */
const VERIFY_OUTPUT_BYTES = 64 * 1024;

/**
 * 任务清单：JSON 校验 + 目录加载（fail-closed）。
 */
export class LongTaskCatalog {
  /** 任务目录缺省值（相对仓库根）。 */
  public static readonly DEFAULT_TASKS_DIR = join('tools', 'eval', 'long-tasks');

  /**
   * 校验一个任务 JSON。
   * @param raw 解析后的 JSON（未知形状一律拒绝）。
   * @returns 校验结果（错误逐条可读）。
   */
  public static validate(raw: unknown): LongTaskValidation {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { ok: false, errors: ['任务必须是 JSON 对象'], spec: undefined };
    }
    const record = raw as Record<string, unknown>;
    const errors: string[] = [];
    const id = record['id'];
    const prompt = record['prompt'];
    const repo = record['repo'];
    const verifyCommand = record['verifyCommand'];
    const expectedFiles = record['expectedFiles'];
    const timeoutMs = record['timeoutMs'];
    const maxTokens = record['maxTokens'];
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
      errors.push('id 必须是 ^[a-z0-9][a-z0-9-]{0,63}$ 的字符串');
    }
    if (typeof prompt !== 'string' || prompt.trim() === '') errors.push('prompt 必须是非空字符串');
    if (typeof repo !== 'string' || !ID_PATTERN.test(repo)) {
      errors.push('repo 必须是 fixture 目录名（^[a-z0-9][a-z0-9-]{0,63}$）');
    }
    if (typeof verifyCommand !== 'string' || verifyCommand.trim() === '') {
      errors.push('verifyCommand 必须是非空字符串（没有机械验收不算成功）');
    }
    const files = LongTaskCatalog.expectedFilesOf(expectedFiles, errors);
    if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs)) {
      errors.push('timeoutMs 必须是整数毫秒');
    } else if (timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
      errors.push(`timeoutMs 必须在 ${String(MIN_TIMEOUT_MS)}..${String(MAX_TIMEOUT_MS)} 之间`);
    }
    if (typeof maxTokens !== 'number' || !Number.isInteger(maxTokens)) {
      errors.push('maxTokens 必须是整数');
    } else if (maxTokens < MIN_MAX_TOKENS || maxTokens > MAX_MAX_TOKENS) {
      errors.push(`maxTokens 必须在 ${String(MIN_MAX_TOKENS)}..${String(MAX_MAX_TOKENS)} 之间`);
    }
    if (errors.length > 0) {
      return { ok: false, errors, spec: undefined };
    }
    return {
      ok: true,
      errors: [],
      spec: {
        id: id as string,
        prompt: (prompt as string).trim(),
        repo: repo as string,
        verifyCommand: (verifyCommand as string).trim(),
        expectedFiles: files,
        timeoutMs: timeoutMs as number,
        maxTokens: maxTokens as number,
      },
    };
  }

  /**
   * 加载一个任务目录下的全部 `*.json`（按文件名排序，保证确定性）。
   * @param tasksDir 目录（通常是 `tools/eval/long-tasks`，其下 `tasks/`）。
   * @returns 任务数组（id 唯一；任何一项非法即抛错，不跳过）。
   */
  public static load(tasksDir: string): readonly LongTaskSpec[] {
    const dir = resolve(tasksDir, 'tasks');
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      throw new Error(`任务目录不存在：${dir}`);
    }
    const files = readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .sort();
    if (files.length === 0) {
      throw new Error(`任务目录没有 JSON：${dir}`);
    }
    const specs: LongTaskSpec[] = [];
    const errors: string[] = [];
    for (const name of files) {
      const path = join(dir, name);
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/u, ''));
      } catch (error) {
        errors.push(`${name}: JSON 解析失败（${error instanceof Error ? error.message : '未知'}）`);
        continue;
      }
      const result = LongTaskCatalog.validate(parsed);
      if (!result.ok || result.spec === undefined) {
        errors.push(...result.errors.map((message) => `${name}: ${message}`));
        continue;
      }
      specs.push(result.spec);
    }
    const seen = new Set<string>();
    for (const spec of specs) {
      if (seen.has(spec.id)) errors.push(`重复任务 id：${spec.id}`);
      seen.add(spec.id);
    }
    if (errors.length > 0) {
      throw new Error(`任务清单非法（${String(errors.length)} 项）：\n${errors.join('\n')}`);
    }
    return specs;
  }

  /**
   * 过滤任务（`--only` 白名单；未知 id 直接抛错，避免「跑了个空集还以为通过」）。
   * @param specs 全量任务。
   * @param only 只跑这些 id（undefined 表示全量）。
   * @returns 过滤后的任务。
   */
  public static filter(
    specs: readonly LongTaskSpec[],
    only?: readonly string[],
  ): readonly LongTaskSpec[] {
    if (only === undefined || only.length === 0) return specs;
    const known = new Set(specs.map((spec) => spec.id));
    const unknown = only.filter((id) => !known.has(id));
    if (unknown.length > 0) throw new Error(`--only 含未知任务 id：${unknown.join(', ')}`);
    const keep = new Set(only);
    return specs.filter((spec) => keep.has(spec.id));
  }

  /**
   * 校验 expectedFiles（必须是仓库内相对路径，拒绝绝对路径与 `..`）。
   * @param raw 原始字段。
   * @param errors 错误累积数组（就地追加）。
   * @returns 规范化后的文件列表；非法时为空数组。
   */
  private static expectedFilesOf(raw: unknown, errors: string[]): readonly string[] {
    if (!Array.isArray(raw) || raw.length === 0) {
      errors.push('expectedFiles 必须是非空数组');
      return [];
    }
    const out: string[] = [];
    for (const item of raw) {
      if (typeof item !== 'string' || item.trim() === '') {
        errors.push('expectedFiles 的每一项必须是非空字符串');
        continue;
      }
      const path = item.trim().replace(/\\/gu, '/');
      const segments = path.split('/');
      if (
        path.startsWith('/') ||
        /^[A-Za-z]:/u.test(path) ||
        segments.some((segment) => segment === '..' || segment === '')
      ) {
        errors.push(`expectedFiles 含越界/绝对路径：${item}`);
        continue;
      }
      if (!out.includes(path)) out.push(path);
    }
    return out;
  }
}

/**
 * 统计口径（**复用** `AbMetrics`：本类只做任务级聚合，不重写 pass@k / pass^k / tokensPerSolved 公式）。
 */
export class LongTaskMetrics {
  /**
   * 汇总一组 run（直接委托 AbMetrics）。
   * @param runs 运行结果。
   * @returns 与 harnessAb 同口径的汇总。
   */
  public static summarizeTask(runs: readonly AbRun[]): AbSummary {
    return AbMetrics.summarize(runs);
  }

  /**
   * 任务集聚合：pass@1 = 总成功/总运行；pass@k / pass^k = 任务级占比；token 口径复用 AbMetrics。
   * @param tasks 每任务的 id 与其 k 次运行。
   * @returns 聚合结果。
   */
  public static aggregate(
    tasks: readonly { readonly id: string; readonly runs: readonly AbRun[] }[],
  ): LongTaskAggregate {
    const summaries = tasks.map((task) => ({
      id: task.id,
      summary: AbMetrics.summarize(task.runs),
    }));
    const total = AbMetrics.summarize(tasks.flatMap((task) => [...task.runs]));
    const count = summaries.length;
    return {
      tasks: count,
      runs: total.runs,
      successes: total.successes,
      passAt1: total.runs === 0 ? 0 : total.successes / total.runs,
      passAtK: count === 0 ? 0 : summaries.filter((item) => item.summary.passAtK).length / count,
      passAllK: count === 0 ? 0 : summaries.filter((item) => item.summary.passAllK).length / count,
      tokens: total.tokens,
      tokensPerSolved: total.tokensPerSolved,
      wallMs: total.wallMs,
    };
  }
}

/**
 * 任务验证执行器（委托通用 {@link VerifyCommandRunner}，口径与长时程协议一致）。
 */
export class LongTaskVerify {
  /**
   * 在隔离仓库里跑一次验证命令。
   * @param spec 任务定义（用其 verifyCommand / timeoutMs）。
   * @param cwd 隔离仓库根。
   * @returns 验证结果（含命令文本，便于报告复核）。
   */
  public static async run(
    spec: Pick<LongTaskSpec, 'verifyCommand' | 'timeoutMs'>,
    cwd: string,
  ): Promise<LongTaskVerifyResult> {
    const outcome = await VerifyCommandRunner.run(
      spec.verifyCommand,
      cwd,
      spec.timeoutMs,
      VERIFY_OUTPUT_BYTES,
    );
    return { ...outcome, command: spec.verifyCommand };
  }
}

/**
 * 隔离沙箱：把 fixture 复制进临时目录并初始化 git（每任务每次运行一个独立仓库）。
 */
export class LongTaskSandbox {
  /** 隔离仓库绝对路径。 */
  public readonly dir: string;
  /** 是否成功初始化 git 仓库（失败即抛错，不会静默降级为非隔离运行）。 */
  public readonly git: boolean;

  /**
   * @param dir 隔离仓库绝对路径。
   * @param git 是否已初始化 git。
   */
  private constructor(dir: string, git: boolean) {
    this.dir = dir;
    this.git = git;
  }

  /**
   * 物化一个隔离仓库。
   * @param options 任务、fixture 根与临时父目录。
   * @returns 沙箱句柄。
   */
  public static materialize(options: LongTaskSandboxOptions): LongTaskSandbox {
    const fixture = join(options.fixturesRoot, options.spec.repo);
    if (!existsSync(fixture) || !statSync(fixture).isDirectory()) {
      throw new Error(`fixture 不存在：${fixture}`);
    }
    mkdirSync(options.rootDir, { recursive: true });
    const dir = mkdtempSync(join(options.rootDir, `${options.spec.id}-`));
    cpSync(fixture, dir, { recursive: true });
    LongTaskSandbox.initGit(dir, options.spec.id);
    return new LongTaskSandbox(dir, true);
  }

  /**
   * 在隔离仓库里初始化 git 并提交 fixture 快照（失败即抛错）。
   * @param dir 仓库目录。
   * @param id 任务 id（提交信息用）。
   * @returns 无返回值。
   */
  private static initGit(dir: string, id: string): void {
    const run = (args: readonly string[]): void => {
      const result = spawnSync('git', [...args], {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (result.status !== 0) {
        const detail = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
        throw new Error(`git ${args.join(' ')} 失败（隔离仓库没建起来）：${detail}`);
      }
    };
    run(['init', '-q']);
    run(['add', '-A']);
    run([
      '-c',
      'user.email=eval@omniharness.local',
      '-c',
      'user.name=omniharness-eval',
      'commit',
      '-q',
      '-m',
      `fixture: ${id}`,
    ]);
  }
}

/**
 * transcript 落盘（每次运行一个文件；报告里回传绝对路径）。
 */
export class LongTaskTranscripts {
  /** transcript 目录。 */
  public readonly dir: string;

  /**
   * @param dir 输出目录（不存在即创建）。
   */
  public constructor(dir: string) {
    this.dir = resolve(dir);
    mkdirSync(this.dir, { recursive: true });
  }

  /**
   * 写一份 transcript。
   * @param taskId 任务 id。
   * @param runIndex 第几次运行（0 基）。
   * @param content 文本内容（调用方负责脱敏：不要把 env 里的凭据写进来）。
   * @returns 文件绝对路径。
   */
  public write(taskId: string, runIndex: number, content: string): string {
    const path = join(this.dir, `${taskId}__run${String(runIndex + 1)}.log`);
    writeFileSync(path, content, 'utf8');
    return path;
  }
}

/**
 * 会话 token 读取（与 `harnessAb.parseSession` 同一求和口径：仅累加模型 usage 事件）。
 */
export class LongTaskSessionUsage {
  /**
   * 从 JSONL 文本累加 token（坏行跳过）。
   * @param text 会话 JSONL 全文。
   * @returns token 总量；无 usage 时为 0（不臆造估算）。
   */
  public static tokensOfJsonl(text: string): number {
    let tokens = 0;
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const record = event as { type?: unknown; payload?: { usage?: { totalTokens?: unknown } } };
      if (record.type !== 'model') continue;
      const total = record.payload?.usage?.totalTokens;
      if (typeof total === 'number' && Number.isFinite(total)) tokens += total;
    }
    return tokens;
  }

  /**
   * 读一次会话存档的 token（缺失文件按 0，不报错）。
   * @param storeDir 会话存储目录。
   * @param sessionId 会话 id（undefined 时按 0）。
   * @returns token 总量。
   */
  public static read(storeDir: string, sessionId: string | undefined): number {
    if (sessionId === undefined) return 0;
    const path = join(storeDir, `${sessionId}.jsonl`);
    if (!existsSync(path)) return 0;
    try {
      return LongTaskSessionUsage.tokensOfJsonl(readFileSync(path, 'utf8'));
    } catch {
      return 0;
    }
  }
}

/**
 * CLI 参数解析与 skip 判定（入口脚本只做 I/O，语义在这里可测）。
 */
export class LongTaskRunPlan {
  /**
   * 解析 `--key value` / `--key=value` 形式的参数（未知旗标 fail-closed）。
   * @param argv 参数数组（不含 node/脚本）。
   * @param defaults 缺省任务目录。
   * @returns 规范化选项。
   */
  public static parseArgs(
    argv: readonly string[],
    defaults: { readonly tasksDir: string },
  ): LongTaskCliOptions {
    let k = 1;
    let dryRun = false;
    let selfCheck = false;
    let longHorizon = false;
    let model: string | undefined;
    let tasksDir = defaults.tasksDir;
    let out: string | undefined;
    let transcriptsDir: string | undefined;
    let only: readonly string[] | undefined;
    for (let i = 0; i < argv.length; i += 1) {
      const token = argv[i] ?? '';
      const [flag, inline] = LongTaskRunPlan.splitFlag(token);
      const value = (): string => {
        if (inline !== undefined) return inline;
        const next = argv[i + 1];
        if (next === undefined) throw new Error(`${flag} 需要取值`);
        i += 1;
        return next;
      };
      if (flag === '--dry-run') dryRun = true;
      else if (flag === '--self-check') selfCheck = true;
      else if (flag === '--long-horizon') longHorizon = true;
      else if (flag === '--k') k = Number(value());
      else if (flag === '--model') model = value();
      else if (flag === '--tasks') tasksDir = value();
      else if (flag === '--out') out = value();
      else if (flag === '--transcripts') transcriptsDir = value();
      else if (flag === '--only')
        only = value()
          .split(',')
          .map((part) => part.trim());
      else throw new Error(`未知参数：${token}`);
    }
    if (!Number.isInteger(k) || k < 1) throw new Error('--k 必须是正整数');
    if (only !== undefined && (only.length === 0 || only.some((id) => id === ''))) {
      throw new Error('--only 必须是非空 id 列表');
    }
    return {
      k,
      dryRun,
      selfCheck,
      longHorizon,
      model,
      tasksDir: resolve(tasksDir),
      out,
      transcriptsDir,
      only,
    };
  }

  /**
   * 无凭据时的显式 skip 理由（**不 mock 冒充真实跑分**）。
   * @param env 进程环境（缺省 `process.env`）。
   * @returns skip 理由；有 key 时 undefined。
   */
  public static skipReason(env: NodeJS.ProcessEnv = process.env): string | undefined {
    const key = env['OMNIHARNESS_API_KEY'];
    if (typeof key === 'string' && key.trim() !== '') return undefined;
    return 'OMNIHARNESS_API_KEY 未设置（显式 skipped，不用 mock 冒充真实长任务跑分）';
  }

  /**
   * `--dry-run` 报告（只含任务 id 与配置，不调模型；不回显凭据）。
   * @param options CLI 选项。
   * @param specs 生效任务。
   * @returns 可 JSON 序列化的计划。
   */
  public static dryRunReport(
    options: LongTaskCliOptions,
    specs: readonly LongTaskSpec[],
  ): Record<string, unknown> {
    return {
      dryRun: true,
      k: options.k,
      model: options.model ?? null,
      longHorizon: options.longHorizon,
      tasksDir: options.tasksDir,
      tasks: specs.map((spec) => ({
        id: spec.id,
        repo: spec.repo,
        verifyCommand: spec.verifyCommand,
        expectedFiles: [...spec.expectedFiles],
        timeoutMs: spec.timeoutMs,
        maxTokens: spec.maxTokens,
      })),
    };
  }

  /**
   * 拆 `--flag=value`（无等号时第二项为 undefined）。
   * @param token 原始 token。
   * @returns 旗标与内联值。
   */
  private static splitFlag(token: string): readonly [string, string | undefined] {
    const index = token.indexOf('=');
    if (index <= 0) return [token, undefined];
    return [token.slice(0, index), token.slice(index + 1)];
  }
}

/**
 * 自检：把 `solutions/<id>.js` + `solutions/<id>.README.md` 覆盖进 fixture，再用同一验证器验收。
 *
 * 为什么要有它：20 个 fixture 的验证器必须**自己先在参考解上跑绿**，否则「任务不可解」会被
 * 误读成「模型不行」。自检不调模型、不需要 API key，可离线复跑。
 */
export class LongTaskSelfCheck {
  /**
   * 跑全部任务的自检。
   * @param deps 任务、任务目录与临时父目录。
   * @returns 自检报告（逐任务 ok/detail）。
   */
  public static async run(deps: {
    readonly specs: readonly LongTaskSpec[];
    readonly tasksDir: string;
    readonly rootDir: string;
  }): Promise<LongTaskSelfCheckReport> {
    const items: LongTaskSelfCheckItem[] = [];
    for (const spec of deps.specs) {
      items.push(await LongTaskSelfCheck.checkOne(spec, deps.tasksDir, deps.rootDir));
    }
    return {
      ok: items.every((item) => item.ok),
      passed: items.filter((item) => item.ok).length,
      failed: items.filter((item) => !item.ok).length,
      items,
    };
  }

  /**
   * 单任务自检：复制 fixture → 覆盖参考解 → 覆盖验证器 → 跑 verifyCommand。
   * @param spec 任务。
   * @param tasksDir 任务目录。
   * @param rootDir 临时父目录。
   * @returns 自检结果。
   */
  private static async checkOne(
    spec: LongTaskSpec,
    tasksDir: string,
    rootDir: string,
  ): Promise<LongTaskSelfCheckItem> {
    const solution = join(tasksDir, 'solutions', `${spec.id}.js`);
    const readme = join(tasksDir, 'solutions', `${spec.id}.README.md`);
    if (!existsSync(solution) || !existsSync(readme)) {
      return { id: spec.id, ok: false, detail: '缺少参考解/参考 README（无法自检）' };
    }
    try {
      const sandbox = LongTaskSandbox.materialize({
        spec,
        fixturesRoot: join(tasksDir, 'fixtures'),
        rootDir,
      });
      cpSync(solution, join(sandbox.dir, 'src', 'index.js'));
      cpSync(readme, join(sandbox.dir, 'README.md'));
      cpSync(join(tasksDir, 'verifiers', `${spec.id}.mjs`), join(sandbox.dir, 'verify.mjs'));
      const verify = await LongTaskVerify.run(spec, sandbox.dir);
      if (!verify.ok) {
        return {
          id: spec.id,
          ok: false,
          detail: `参考解未通过验证器（exit=${String(verify.exitCode)}）：${verify.output.slice(-400)}`,
        };
      }
      const missing = spec.expectedFiles.filter((file) => !existsSync(join(sandbox.dir, file)));
      return {
        id: spec.id,
        ok: missing.length === 0,
        detail: missing.length === 0 ? 'ok' : `缺少文件：${missing.join(', ')}`,
      };
    } catch (error) {
      return {
        id: spec.id,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
