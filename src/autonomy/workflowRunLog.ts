import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { WorkflowSpecError } from './workflowSpecError.js';
import type { WorkflowDef } from '../ports/autonomy/workflowDef.js';
import type { WorkflowStepStatus } from '../ports/autonomy/workflowStepStatus.js';

/** 运行日志目录（位于工作区 `.omniharness` 下，与图定义目录同级）。 */
const RUN_DIR = '.omniharness/graph-runs';

/** 单个运行日志的体积上限：超此大小拒绝整文件读入（fail-closed，避免病态文件 OOM）。 */
const MAX_RUN_BYTES = 8 * 1024 * 1024;

/** 运行日志首行（run.start）：自描述——**续跑只需 runId**，规格从本行读回。 */
export interface WorkflowRunHeader {
  /** 行类型判别符。 */
  readonly t: 'run.start';
  /** 运行 id（文件名安全）。 */
  readonly runId: string;
  /** 工作流名（可选，便于人读）。 */
  readonly name?: string | undefined;
  /** 规格规范化后的 sha256（续跑时校验同一份定义）。 */
  readonly specHash: string;
  /** 生效的同层并发上限。 */
  readonly maxConcurrency: number;
  /** 写入时刻（ISO）。 */
  readonly at: string;
  /** 完整规格（续跑时据此重建 DAG，避免「调用方记错定义」）。 */
  readonly spec: WorkflowDef;
}

/** 步骤开始行（崩溃恢复的判据：有 start 无 end ⇒ 中断点）。 */
export interface WorkflowStepStartLine {
  /** 行类型判别符。 */
  readonly t: 'step.start';
  /** 步骤 id。 */
  readonly id: string;
  /** 第几次尝试（从 1 起；续跑会递增，重试事实完整留痕）。 */
  readonly attempt: number;
  /** 写入时刻（ISO）。 */
  readonly at: string;
}

/** 步骤终态行。 */
export interface WorkflowStepEndLine {
  /** 行类型判别符。 */
  readonly t: 'step.end';
  /** 步骤 id。 */
  readonly id: string;
  /** 终态。 */
  readonly status: WorkflowStepStatus;
  /** 第几次尝试。 */
  readonly attempt: number;
  /** 成功时的产出。 */
  readonly output?: string | undefined;
  /** 失败/跳过原因。 */
  readonly error?: string | undefined;
  /** 子智能体步数。 */
  readonly steps: number;
  /** 耗时（毫秒）。 */
  readonly durationMs: number;
  /** 是否因步数耗尽截断。 */
  readonly truncated?: boolean | undefined;
  /** 是否被失控熔断/取消。 */
  readonly aborted?: boolean | undefined;
  /** 写入时刻（ISO）。 */
  readonly at: string;
}

/** 运行结束行。 */
export interface WorkflowRunEndLine {
  /** 行类型判别符。 */
  readonly t: 'run.end';
  /** 整体是否成功。 */
  readonly ok: boolean;
  /** 写入时刻（ISO）。 */
  readonly at: string;
}

/** 运行日志的一行（联合类型）。 */
export type WorkflowRunLine =
  WorkflowRunHeader | WorkflowStepStartLine | WorkflowStepEndLine | WorkflowRunEndLine;

/** 续跑所需的**回放状态**（只读投影，不让调用方拿到半解析的内部结构）。 */
export interface WorkflowRunReplay {
  /** 运行首行（含规格与并发上限）。 */
  readonly header: WorkflowRunHeader;
  /** 已有终态的步骤（done / failed / skipped / blocked / cancelled）。 */
  readonly statuses: ReadonlyMap<string, WorkflowStepStatus>;
  /** `done` 步骤的产出（可直接注入下游 prompt）。 */
  readonly outputs: ReadonlyMap<string, string>;
  /** 起过但没有终态的步骤 = 崩溃点（续跑必须重跑它们）。 */
  readonly interrupted: ReadonlySet<string>;
  /** 各步骤已发生的尝试次数（id → 次数）。 */
  readonly attempts: ReadonlyMap<string, number>;
  /** 上一次运行是否已写下 `run.end`。 */
  readonly ended: boolean;
}

/**
 * @beta
 * 工作流**运行状态日志**（append-only JSONL）：`<workspace>/.omniharness/graph-runs/<runId>.jsonl`。
 *
 * ## 为什么是「追加日志」而不是 LangGraph 式全量快照
 *
 * 决策记录见 `docs/ARCHITECTURE_UPGRADE_2026-10.md` §3.1「不建议采纳」：每 superstep 全量快照
 * 写放大严重且无界增长；本仓既有的会话持久化哲学就是「**追加日志 + 压缩游标**」。本类沿用同一口径：
 * 每步只写 start / end 两行，续跑时按 id 折叠出「哪些已完成、哪些中断」。
 *
 * ## 崩溃语义（商业级的关键在「诚实」）
 *
 * 进程在写某一行的中途被杀会留下**半截行**：本类在解析时**只容忍最后一行不完整**（正是崩溃现场），
 * 而中间行损坏一律**拒绝加载**（`WorkflowSpecError`）——静默跳过中间损坏会把「丢了一步的产出」
 * 伪装成「那一轮没跑过」，是最危险的故障形态。
 */
export class WorkflowRunLog {
  /**
   * @param workspaceRoot 工作区根（运行日志目录相对它创建）。
   */
  public constructor(private readonly workspaceRoot: string) {}

  /**
   * 生成运行 id（文件名安全：只含 `[A-Za-z0-9_-]`，且带时间戳便于排序）。
   *
   * @param name 工作流名（可选，仅取安全前缀）。
   * @returns 形如 `wf-20261008T101530-1a2b3c` 的 id。
   */
  public static newRunId(name?: string): string {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
    const slug = (name ?? '')
      .replace(/[^A-Za-z0-9_-]/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24);
    const prefix = slug.length > 0 ? `${slug}-` : '';
    return `wf-${prefix}${stamp}-${randomUUID().slice(0, 6)}`;
  }

  /**
   * 计算规格的稳定哈希（对象键排序后 sha256；数组顺序**保留**——步骤顺序影响同层 tie-break）。
   *
   * @param def 工作流规格。
   * @returns 16 进制 sha256。
   */
  public static hashSpec(def: WorkflowDef): string {
    return createHash('sha256').update(WorkflowRunLog.stableStringify(def)).digest('hex');
  }

  /**
   * 运行日志文件路径（**不校验存在性**）。
   *
   * @param runId 运行 id（须为 {@link newRunId} 口径的安全串）。
   * @returns 绝对路径。
   */
  public pathOf(runId: string): string {
    return join(this.workspaceRoot, RUN_DIR, `${WorkflowRunLog.requireSafeRunId(runId)}.jsonl`);
  }

  /**
   * 创建一次新运行（写首行）。
   *
   * @param def 工作流规格。
   * @param runId 运行 id（缺省由 {@link newRunId} 生成）。
   * @param maxConcurrency 生效的同层并发上限。
   * @returns 已落盘的首行。
   */
  public create(def: WorkflowDef, runId: string, maxConcurrency: number): WorkflowRunHeader {
    const header: WorkflowRunHeader = {
      t: 'run.start',
      runId: WorkflowRunLog.requireSafeRunId(runId),
      ...(def.name !== undefined ? { name: def.name } : {}),
      specHash: WorkflowRunLog.hashSpec(def),
      maxConcurrency,
      at: new Date().toISOString(),
      spec: def,
    };
    // 覆盖写：**同一个 runId 的新运行不得继承旧运行的状态**（serve 的台账 id 会复用，
    // 而 `read()` 取的是首个 run.start 行——不覆盖就会把两次运行折叠成一次）。
    this.append(header.runId, header, true);
    return header;
  }

  /**
   * 记录某步开始（崩溃恢复的判据）。
   *
   * @param runId 运行 id。
   * @param id 步骤 id。
   * @param attempt 第几次尝试（从 1 起）。
   * @returns 无返回值。
   */
  public appendStepStart(runId: string, id: string, attempt: number): void {
    this.append(runId, { t: 'step.start', id, attempt, at: new Date().toISOString() });
  }

  /**
   * 记录某步终态。
   *
   * @param runId 运行 id。
   * @param line 终态行（除 `t`/`at` 外的字段，`at` 由本方法补）。
   * @returns 无返回值。
   */
  public appendStepEnd(runId: string, line: Omit<WorkflowStepEndLine, 't' | 'at'>): void {
    this.append(runId, { t: 'step.end', ...line, at: new Date().toISOString() });
  }

  /**
   * 记录整体结束。
   *
   * @param runId 运行 id。
   * @param ok 整体是否成功。
   * @returns 无返回值。
   */
  public appendRunEnd(runId: string, ok: boolean): void {
    this.append(runId, { t: 'run.end', ok, at: new Date().toISOString() });
  }

  /**
   * 读取并折叠一次运行的状态（续跑入口）。
   *
   * @param runId 运行 id。
   * @returns 回放状态。
   * @throws WorkflowSpecError 日志不存在 / 超限 / 首行非法 / 中间行损坏 / 规格哈希自校验失败时抛出。
   */
  public read(runId: string): WorkflowRunReplay {
    const path = this.pathOf(runId);
    if (!existsSync(path)) {
      throw new WorkflowSpecError(`找不到运行日志：${path}（runId 是否正确？）`);
    }
    const size = statSync(path).size;
    if (size > MAX_RUN_BYTES) {
      throw new WorkflowSpecError(
        `运行日志过大（${Math.round(size / 1024 / 1024)}MB > ${MAX_RUN_BYTES / 1024 / 1024}MB）：${path}`,
      );
    }
    const lines = readFileSync(path, 'utf8')
      .split('\n')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    const parsed = WorkflowRunLog.parseAll(lines, path);
    const header = parsed.find((line) => line.t === 'run.start') as WorkflowRunHeader | undefined;
    if (header === undefined) {
      throw new WorkflowSpecError(`运行日志缺少 run.start 首行：${path}`);
    }
    if (WorkflowRunLog.hashSpec(header.spec) !== header.specHash) {
      throw new WorkflowSpecError(
        `运行日志自校验失败（specHash 与内嵌 spec 不一致，文件可能被外部改动）：${path}`,
      );
    }
    return WorkflowRunLog.fold(header, parsed);
  }

  /**
   * 追加一行（目录按需创建；写失败**不吞**——运行状态丢失必须让调用方知道）。
   *
   * @param runId 运行 id。
   * @param line 待写行。
   * @param overwrite 是否覆盖既有文件（仅 {@link create} 首行使用：同 id 的新运行不得继承旧状态）。
   * @returns 无返回值。
   */
  private append(runId: string, line: WorkflowRunLine, overwrite = false): void {
    const path = this.pathOf(runId);
    const dir = join(this.workspaceRoot, RUN_DIR);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const text = `${JSON.stringify(line)}\n`;
    if (overwrite) {
      writeFileSync(path, text, 'utf8');
      return;
    }
    appendFileSync(path, text, 'utf8');
  }

  /**
   * 解析全部行：**只容忍最后一行不完整**（崩溃现场），中间损坏即抛。
   *
   * @param lines 非空行数组。
   * @param path 日志路径（错误定位用）。
   * @returns 解析后的行。
   * @throws WorkflowSpecError 中间行不可解析时抛出。
   */
  private static parseAll(lines: readonly string[], path: string): readonly WorkflowRunLine[] {
    const out: WorkflowRunLine[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      try {
        out.push(JSON.parse(lines[index]!) as WorkflowRunLine);
      } catch (error) {
        const isLast = index === lines.length - 1;
        if (isLast) {
          break; // 崩溃时写了一半的最后一行：容忍，且不静默丢中间数据。
        }
        throw new WorkflowSpecError(
          `运行日志第 ${index + 1} 行损坏（非末行，拒绝加载以免丢步）：${path}｜${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return out;
  }

  /**
   * 把行序列折叠为回放状态。
   *
   * @param header 首行。
   * @param lines 已解析行。
   * @returns 回放状态。
   */
  private static fold(
    header: WorkflowRunHeader,
    lines: readonly WorkflowRunLine[],
  ): WorkflowRunReplay {
    const statuses = new Map<string, WorkflowStepStatus>();
    const outputs = new Map<string, string>();
    const interrupted = new Set<string>();
    const attempts = new Map<string, number>();
    let ended = false;
    for (const line of lines) {
      if (line.t === 'step.start') {
        attempts.set(line.id, Math.max(attempts.get(line.id) ?? 0, line.attempt));
        interrupted.add(line.id);
        // **新的尝试作废上一次终态**（2026-10-08 判据抓到的真缺陷）：某步先 `done`、随后又出现一条
        // `step.start`（= 又跑了一次且结果未知）时，续跑若仍复用旧产出，就是把「上一次尝试的结论」
        // 当成「当前事实」——而那次重跑可能已经改过工作区。故 start 到达即清掉该步的终态与产出，
        // 交给本次运行重跑；可信的终态只认**最后一条** `step.end`。
        statuses.delete(line.id);
        outputs.delete(line.id);
        continue;
      }
      if (line.t === 'step.end') {
        attempts.set(line.id, Math.max(attempts.get(line.id) ?? 0, line.attempt));
        statuses.set(line.id, line.status);
        interrupted.delete(line.id);
        if (line.status === 'done' && line.output !== undefined) {
          outputs.set(line.id, line.output);
        } else {
          outputs.delete(line.id);
        }
        continue;
      }
      if (line.t === 'run.end') {
        ended = true;
      }
    }
    return { header, statuses, outputs, interrupted, attempts, ended };
  }

  /**
   * 规范化序列化（对象键排序；数组保序），用于稳定哈希。
   *
   * @param value 任意 JSON 值。
   * @returns 稳定字符串。
   */
  private static stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') {
      return JSON.stringify(value) ?? 'null';
    }
    if (Array.isArray(value)) {
      return `[${value.map((entry) => WorkflowRunLog.stableStringify(entry)).join(',')}]`;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${WorkflowRunLog.stableStringify(record[key])}`)
      .join(',')}}`;
  }

  /**
   * 校验 runId 的文件名安全性（拒绝路径穿越与非法字符）。
   *
   * @param runId 运行 id。
   * @returns 原样返回合法 id。
   * @throws WorkflowSpecError 非法时抛出。
   */
  private static requireSafeRunId(runId: string): string {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(runId)) {
      throw new WorkflowSpecError(
        `runId 非法（只允许 [A-Za-z0-9_-] 且长度 ≤80）：${JSON.stringify(runId)}`,
      );
    }
    return runId;
  }
}
