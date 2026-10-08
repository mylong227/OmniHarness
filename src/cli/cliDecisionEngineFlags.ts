/**
 * （Laya 战略线）决策引擎段的 CLI 解析：配置文件段 + 旗标覆盖 → `decisionEngine` 片段。
 *
 * ## 为什么默认 `shadow`（而库级默认仍是 `off`）
 *
 * 本仓既有口径是分层的：**库级**（`ConfigFactory`）保持「不装配即零行为」，单测与嵌入方不受影响；
 * **生产入口**（CLI）才给「观测档常开」的默认——`promptInjectionGuard`（默认 shadow）与
 * `selfVerify`（默认开）都是这样。
 *
 * 决策引擎此前**两处都是 off，而且没有任何用户面入口**：配置文件写不进去（未知 key）、CLI 也无旗标
 * ⇒ 生产部署下引擎恒不构造，项目内 1.7GB 的 venv + 权重在真实运行里零调用，且因为全程 fail-open
 * 而没有一行告警（2026-10 实测）。默认 `shadow` 的语义是「跑、记、不改行为」：不影响主流程正确性，
 * 同时把「到底有没有在用 Laya」变成可观测事实（适配器会落一条结构化日志，`trace` 默认落盘）。
 *
 * ## 解析顺序
 *
 * 1. 模式：`--decision-engine <mode>` / `--no-decision-engine` → 配置文件 `mode` → `shadow`；
 * 2. 解释器：`--decision-engine-python <path>` → 配置文件 `pythonPath` → 交给适配器自动探测
 *    （`LAYA_PYTHON_BIN` → 项目内 `third-party/laya-venv` → `python3`）；
 * 3. 其余字段（`repo` / `modelDir` / `warm` / `timeoutMs` / `trace`）仅来自配置文件段，原样透传。
 *
 * `off` 一律返回 `undefined`（不写 `partial` ⇒ 引擎不装配、零行为），而不是写一个 `{mode:'off'}`。
 */

import type { CliArgs } from './argParser.js';
import type { DecisionEngineConfig } from '../ports/config/decisionEngineConfig.js';

/** 生产入口默认档位：只观测、不改行为（详见类注释「为什么默认 shadow」）。 */
const DEFAULT_MODE: DecisionEngineConfig['mode'] = 'shadow';

/** 决策引擎段的 CLI 解析器（无状态）。 */
export class CliDecisionEngineFlags {
  /**
   * 解析决策引擎段。
   *
   * @param args 解析后的 CLI 参数（含配置文件映射来的 `decisionEngine` 与三个旗标取值）。
   * @returns 决策引擎配置片段；档位为 `off` 时返回 `undefined`（不装配、零行为）。
   */
  public static resolve(args: CliArgs): DecisionEngineConfig | undefined {
    const file = args.decisionEngine;
    const mode = args.decisionEngineMode ?? file?.mode ?? DEFAULT_MODE;
    if (mode === 'off') {
      return undefined;
    }
    const pythonPath = args.decisionEnginePython ?? file?.pythonPath;
    return {
      mode,
      ...(pythonPath !== undefined ? { pythonPath } : {}),
      ...(file?.modelDir !== undefined ? { modelDir: file.modelDir } : {}),
      ...(file?.repo !== undefined ? { repo: file.repo } : {}),
      ...(file?.warm !== undefined ? { warm: file.warm } : {}),
      ...(file?.timeoutMs !== undefined ? { timeoutMs: file.timeoutMs } : {}),
      ...(file?.trace !== undefined ? { trace: file.trace } : {}),
    };
  }
}
