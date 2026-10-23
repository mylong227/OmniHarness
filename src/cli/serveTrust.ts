/**
 * serve 的工作区信任选项装配（2026-10-22）。
 *
 * 从 `cliServerCmds` 抽出：god-class 代码行数门禁不允许把信任回调再塞进类体；
 * 该对象只持有回调与可变结果，不发起 IO。
 */
import type { WorkspaceTrustOptions } from '../config/configFile.ts';
import { WorkspaceTrust } from '../config/workspaceTrust.ts';

/** 信任选项 + 回调后的可读结果。 */
export interface ServeTrustBinding {
  /** 传给 loadServeConfig 的选项。 */
  readonly options: WorkspaceTrustOptions;
  /** 回调后更新的状态（默认未信任）。 */
  readonly state: { trusted: boolean };
}

/** serve 信任选项工厂。 */
export class ServeTrust {
  /**
   * 创建绑定。
   * @param serveArgs serve 子命令参数。
   * @returns 选项与状态（onDecision 时更新 state.trusted）。
   */
  public static create(serveArgs: readonly string[]): ServeTrustBinding {
    const state = { trusted: false };
    const options: WorkspaceTrustOptions = {
      grant: serveArgs.includes('--trust-workspace'),
      onDecision: (decision) => {
        state.trusted = decision.mode === 'trusted';
        const lines = WorkspaceTrust.describe(decision);
        if (lines.length > 0) process.stderr.write(`${lines.join('\n')}\n`);
      },
    };
    return { options, state };
  }
}
