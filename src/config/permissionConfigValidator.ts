/**
 * `permission` 配置段严格校验（fail-closed，A2）。
 *
 * 为什么单独成类：`configError.ts` 已是 1 类 1 文件的形态（`ConfigError`），再塞一个校验类会越过
 * 「一文件一类」红线；而把校验写成新的顶层 `function` 又违反 D9（新代码禁顶层 function）。
 * 因此独立为「文件名 = 类名」的校验类，由 `configError.ts` 以注册项接入字段校验链。
 *
 * 返回值约定：返回**错误消息字符串**（合法则 `undefined`）而非直接抛 `ConfigError`——
 * 这样本模块无需 import `configError.ts` 的 `ConfigError` 值，从根上避免
 * `configError ↔ permissionConfigValidator` 的模块级循环依赖。抛错由注册方完成。
 */

import type { FileConfig } from './configFile.js';

/** `permission` 段允许的 key 全集。 */
const PERMISSION_KEYS: ReadonlySet<string> = new Set(['rules', 'defaultDecision']);

/** 单条规则允许的 key 全集。 */
const RULE_KEYS: ReadonlySet<string> = new Set([
  'toolName',
  'commandPrefix',
  'commandGlob',
  'decision',
]);

/** 规则中需为非空字符串的可选字段。 */
const STRING_RULE_FIELDS = ['toolName', 'commandPrefix', 'commandGlob'] as const;

/** 合法裁决值。 */
const DECISIONS: ReadonlySet<string> = new Set(['allow', 'deny', 'ask']);

/** permission 配置段校验器（无状态，可并发复用）。 */
export class PermissionConfigValidator {
  /**
   * 校验 `FileConfig.permission`：结构 / 未知 key / 裁决枚举 / 规则字段类型。
   * @param cfg 已归一化的分层配置。
   * @returns 首个错误消息；全部合法时返回 undefined。
   */
  public validate(cfg: FileConfig): string | undefined {
    const raw = (cfg as Record<string, unknown>).permission;
    if (raw === undefined) {
      return undefined;
    }
    if (!this.isPlainObject(raw)) {
      return 'permission 应为对象';
    }
    const unknown = this.firstUnknownKey(raw, PERMISSION_KEYS);
    if (unknown !== undefined) {
      return `permission 含未知配置项 "${unknown}"`;
    }
    const decisionError = this.checkDecision(raw.defaultDecision, 'permission.defaultDecision');
    if (decisionError !== undefined) {
      return decisionError;
    }
    return this.checkRules(raw.rules);
  }

  /**
   * 判断值是否为普通对象（非 null / 非数组）。
   * @param value 待判定值。
   * @returns 是普通对象为 true。
   */
  private isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  /**
   * 取对象中首个不在白名单内的 key。
   * @param obj 待检对象。
   * @param allowed 允许的 key 集合。
   * @returns 首个未知 key；无未知 key 时 undefined。
   */
  private firstUnknownKey(
    obj: Record<string, unknown>,
    allowed: ReadonlySet<string>,
  ): string | undefined {
    return Object.keys(obj).find((key) => !allowed.has(key));
  }

  /**
   * 校验裁决值（存在则须为 allow/deny/ask）。
   * @param value 待校验值。
   * @param label 报错时使用的字段路径。
   * @returns 错误消息；合法或未声明时 undefined。
   */
  private checkDecision(value: unknown, label: string): string | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (!DECISIONS.has(String(value))) {
      return `${label} 取值 "${String(value)}" 非法，允许: allow | deny | ask`;
    }
    return undefined;
  }

  /**
   * 校验 `rules` 数组。
   * @param rules 待校验值。
   * @returns 首个错误消息；合法或未声明时 undefined。
   */
  private checkRules(rules: unknown): string | undefined {
    if (rules === undefined) {
      return undefined;
    }
    if (!Array.isArray(rules)) {
      return 'permission.rules 应为数组';
    }
    for (const [index, rule] of rules.entries()) {
      const error = this.checkRule(rule, index);
      if (error !== undefined) {
        return error;
      }
    }
    return undefined;
  }

  /**
   * 校验单条规则。
   * @param rule 待校验值。
   * @param index 规则下标（报错定位）。
   * @returns 错误消息；合法时 undefined。
   */
  private checkRule(rule: unknown, index: number): string | undefined {
    if (!this.isPlainObject(rule)) {
      return `permission.rules[${index}] 应为对象`;
    }
    const unknown = this.firstUnknownKey(rule, RULE_KEYS);
    if (unknown !== undefined) {
      return `permission.rules[${index}] 含未知配置项 "${unknown}"`;
    }
    const decisionError = this.checkDecision(rule.decision, `permission.rules[${index}].decision`);
    if (decisionError !== undefined) {
      return decisionError;
    }
    for (const field of STRING_RULE_FIELDS) {
      const value = rule[field];
      if (value !== undefined && (typeof value !== 'string' || value === '')) {
        return `permission.rules[${index}].${field} 应为非空字符串`;
      }
    }
    return undefined;
  }
}

/** 默认无状态实例（调用点以 `permissionConfigValidator.validate` 零构造复用）。 */
export const permissionConfigValidator = new PermissionConfigValidator();
