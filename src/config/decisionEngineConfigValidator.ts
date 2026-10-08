/**
 * `decisionEngine` 配置段严格校验（fail-closed）。
 *
 * ## 为什么这一段必须严格
 *
 * 它是本仓「声明未接线」事故的现场：`mode` 从未被任何配置源打开过，而解释器默认值指向系统
 * `python3`（无 laya/torch）⇒ 1.7GB 的 venv + 权重在运行时零调用，**且因为全程 fail-open
 * 而没有一行告警**。配置面的静默忽略在这里代价最高：用户写了 `"pythonPath"`，若被拼错成
 * `"pythonpath"` 就整段失效，排查成本远高于当场拒绝启动。
 *
 * 故本类只做「写错了」的拦截：结构 / 未知 key / 类型 / 枚举。数值范围（如 `timeoutMs`）
 * 不做上限收敛——设置过长只会拖慢自身，不构成静默失效。
 *
 * 返回值约定：返回**错误消息字符串**（合法则 `undefined`）而非抛 `ConfigError`，
 * 从而无需 import `configError.ts` 的值，从根上避免 `configError ↔ 本模块` 的循环依赖。
 */

import type { FileConfig } from '../ports/config/fileConfig.js';

/** `decisionEngine` 段允许的 key 全集（新增配置项必须同时加到 `DecisionEngineConfig` 与本表）。 */
const DECISION_KEYS: ReadonlySet<string> = new Set([
  'mode',
  'repo',
  'pythonPath',
  'modelDir',
  'warm',
  'timeoutMs',
  'trace',
]);

/** 生效模式白名单（与端口类型 `DecisionEngineConfig['mode']` 同源取值）。 */
const MODES: readonly string[] = ['off', 'shadow', 'enforce'];

/** 非空字符串型 key（路径 / checkpoint 名）。 */
const STRING_KEYS: readonly string[] = ['repo', 'pythonPath', 'modelDir'];

/** 布尔型 key。 */
const BOOLEAN_KEYS: readonly string[] = ['warm', 'trace'];

/** `decisionEngine` 配置段校验器（无状态，可并发复用）。 */
export class DecisionEngineConfigValidator {
  /**
   * 校验 `FileConfig.decisionEngine`：结构 → 未知 key → 模式枚举 → 逐字段类型。
   *
   * @param cfg 已归一化的分层配置。
   * @returns 首个错误消息；全部合法时返回 `undefined`。
   */
  public validate(cfg: FileConfig): string | undefined {
    const raw = (cfg as Record<string, unknown>)['decisionEngine'];
    if (raw === undefined) {
      return undefined;
    }
    if (!DecisionEngineConfigValidator.isPlainObject(raw)) {
      return 'decisionEngine 应为对象（字段：mode / repo / pythonPath / modelDir / warm / timeoutMs / trace）';
    }
    for (const key of Object.keys(raw)) {
      if (!DECISION_KEYS.has(key)) {
        return `decisionEngine 含未知 key '${key}'（允许：${[...DECISION_KEYS].join(' / ')}）`;
      }
    }
    const mode = raw['mode'];
    if (mode !== undefined && !MODES.includes(mode as string)) {
      return `decisionEngine.mode 只能是 ${MODES.join(' / ')}（收到 ${DecisionEngineConfigValidator.describe(mode)}）`;
    }
    for (const key of STRING_KEYS) {
      const value = raw[key];
      if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
        return `decisionEngine.${key} 应为非空字符串（收到 ${DecisionEngineConfigValidator.describe(value)}）`;
      }
    }
    for (const key of BOOLEAN_KEYS) {
      const value = raw[key];
      if (value !== undefined && typeof value !== 'boolean') {
        return `decisionEngine.${key} 应为布尔值（收到 ${DecisionEngineConfigValidator.describe(value)}）`;
      }
    }
    const timeout = raw['timeoutMs'];
    if (
      timeout !== undefined &&
      (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0)
    ) {
      return `decisionEngine.timeoutMs 应为正有限数（毫秒，收到 ${DecisionEngineConfigValidator.describe(timeout)}）`;
    }
    return undefined;
  }

  /**
   * 是否普通对象（排除数组 / null）——类型谓词，使调用点可直接按键取值。
   *
   * @param value 待判值。
   * @returns 是普通对象时为 true（并把类型收窄为 `Record<string, unknown>`）。
   */
  private static isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  /**
   * 把任意值渲染成诊断文本（截断，避免把整份配置回显进错误）。
   *
   * @param value 待渲染值。
   * @returns 简短可读文本。
   */
  private static describe(value: unknown): string {
    const text = typeof value === 'string' ? `"${value}"` : String(value);
    return text.length > 60 ? `${text.slice(0, 57)}…` : text;
  }
}

/** 默认无状态实例（调用点以 `decisionEngineConfigValidator.validate` 零构造复用）。 */
export const decisionEngineConfigValidator = new DecisionEngineConfigValidator();
