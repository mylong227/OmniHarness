/**
 * 决策引擎解析（Laya 战略线）：配置 → 适配器构造的唯一构造点。
 *
 * 为什么独立成模块（不在 `ConfigFactory`）：`ConfigFactory` 已贴文件行数门禁上限，
 * 把解析逻辑抽出来既满足「一文件一类」，也给组合根减负。
 *
 * 仅当 `config.decisionEngine.mode !== 'off'` 时构造 `LayaDecisionEngine`；`off` / 缺省
 * 返回 `undefined`（不装配，零行为——与 `selfVerify` 同模式）。
 */
import type { DecisionEngine } from '../ports/decision/decisionEngine.js';
import { LayaDecisionEngine } from '../adapters/laya/layaDecisionEngine.js';
import type { OmniHarnessConfig } from './configFactory.js';

/**
 * 决策引擎解析器：组合根里「配置 → 决策引擎适配器」的唯一构造点。
 *
 * `off` / 缺省返回 `undefined`（不装配、零行为）；`shadow` / `enforce` 构造
 * `LayaDecisionEngine` 实例（行为差异在调用方，不在构造点）。
 */
export class DecisionEngineResolver {
  /**
   * 解析决策引擎。
   *
   * @param partial 未解析的运行配置。
   * @returns 决策引擎；off / 缺省时为 undefined。
   */
  public resolve(partial: OmniHarnessConfig): DecisionEngine | undefined {
    const cfg = partial.decisionEngine;
    if (cfg === undefined || cfg.mode === 'off') {
      return undefined;
    }
    return new LayaDecisionEngine({
      ...(cfg.repo !== undefined ? { repo: cfg.repo } : {}),
      ...(cfg.pythonPath !== undefined ? { pythonPath: cfg.pythonPath } : {}),
    });
  }
}
