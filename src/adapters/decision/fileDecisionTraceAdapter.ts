/**
 * 文件决策 trace 适配器（Laya 战略线）：把 `DecisionTrace` 以 append-only JSONL 落盘到
 * `<workspaceRoot>/.omniharness/decision-traces/<YYYY-MM-DD>.jsonl`，按日分文件便于轮换与离线聚合
 * （每行一条样本，后续用任意 JSONL 工具即可算「预判概率 vs 真实通过率」一致性）。
 *
 * fail-open：目录创建 / 写入失败一律静默吞掉（不写 stderr、不抛错——避免污染主流程日志），
 * 调用方（自验证装饰器）行为不受影响。trace 是质量信号、非安全边界。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DecisionTrace, DecisionTracePort } from '../../ports/decision/decisionTrace.js';

/** 默认 trace 根目录名（相对 workspaceRoot，位于 .omniharness 下，通常被 gitignore）。 */
const TRACE_DIR_NAME = '.omniharness/decision-traces';

/**
 * 文件决策 trace 适配器：每条样本追加一行 JSON 到当日文件（UTC 日期分片）。
 */
export class FileDecisionTraceAdapter implements DecisionTracePort {
  /** 端口名。 */
  public readonly name = 'file-decision-trace';

  /** 落盘目录绝对路径。 */
  private readonly dir: string;

  /**
   * @param workspaceRoot 工作区根（trace 目录相对它创建）。
   */
  public constructor(workspaceRoot: string) {
    this.dir = join(workspaceRoot, TRACE_DIR_NAME);
  }

  /**
   * 记录一条 trace：追加一行 JSON（含换行）到当日文件。
   *
   * 失败静默（目录不可写 / 磁盘满等）一律吞掉——trace 是质量信号、非安全边界。
   *
   * @param trace 配对样本。
   * @returns 无返回值。
   */
  public record(trace: DecisionTrace): void {
    let line: string;
    try {
      line = `${JSON.stringify(trace)}\n`;
    } catch {
      return; // 序列化失败（极端非法字段）静默跳过。
    }
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(join(this.dir, this.dayFile()), line, 'utf8');
    } catch {
      // fail-open：落盘失败不得影响主流程。
    }
  }

  /**
   * 当日 trace 文件名（UTC 日期，避免时区导致分片错位）。
   *
   * @returns `<YYYY-MM-DD>.jsonl`。
   */
  private dayFile(): string {
    return `${new Date().toISOString().slice(0, 10)}.jsonl`;
  }
}
