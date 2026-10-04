/**
 * `capability` 配置段校验（Wave B · ADR-0009）。
 *
 * 只拦「写错了」（未知 key / 类型不符 / 枚举越界），**不做业务收敛**：默认档的优先级与最终取值
 * 由装配器 `CapabilityStackAssembler` 决定并回显——与 `media`/`ssrfPolicy` 两段同一条分工。
 *
 * 为什么必须严格：`capability` 段里写错的键（如 `isolationDefault` 少个 s）若被静默忽略，
 * 使用者会以为「隔离档已收紧」，实际跑的是默认档——这正是本仓反复登记的「声明未接入」形态，
 * 且落在**安全档位**上，代价最高。
 */
import { ISOLATION_LEVEL_ORDER, TRUST_TIER_ORDER } from '../ports/capability.js';
import type { FileConfig } from '../ports/config/fileConfig.js';

/** 允许的 `capability` 子键（拼错即报错）。 */
const CAPABILITY_KEYS: ReadonlySet<string> = new Set(['enabled', 'sources', 'isolationDefaults']);

/** 允许的 `capability.isolationDefaults` 子键。 */
const ISOLATION_DEFAULT_KEYS: ReadonlySet<string> = new Set(['trustTier', 'isolation']);

/** `capability` 配置段校验器（纯静态，无状态）。 */
export class CapabilityConfigValidator {
  private constructor() {}

  /**
   * 校验 `capability` 段。
   * @param file 已归一化的文件配置
   * @returns undefined = 通过；否则为可行动的错误消息
   */
  public static validate(file: FileConfig): string | undefined {
    const section = (file as { readonly capability?: unknown }).capability;
    if (section === undefined) return undefined;
    if (typeof section !== 'object' || section === null || Array.isArray(section)) {
      return 'capability 段必须是对象';
    }
    const record = section as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!CAPABILITY_KEYS.has(key)) {
        return `capability 段未知配置项 "${key}"（可用：${[...CAPABILITY_KEYS].join(' / ')}）`;
      }
    }
    if (record['enabled'] !== undefined && typeof record['enabled'] !== 'boolean') {
      return 'capability.enabled 必须是布尔值';
    }
    const sources = record['sources'];
    if (
      sources !== undefined &&
      (!Array.isArray(sources) || sources.some((entry) => typeof entry !== 'string'))
    ) {
      return 'capability.sources 必须是字符串数组（资产来源路径；Wave D 消费）';
    }
    return CapabilityConfigValidator.validateIsolationDefaults(record['isolationDefaults']);
  }

  /**
   * 校验 `capability.isolationDefaults` 子段（枚举越界即拒）。
   * @param section 子段原值
   * @returns undefined = 通过；否则为错误消息
   */
  private static validateIsolationDefaults(section: unknown): string | undefined {
    if (section === undefined) return undefined;
    if (typeof section !== 'object' || section === null || Array.isArray(section)) {
      return 'capability.isolationDefaults 必须是对象';
    }
    const record = section as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!ISOLATION_DEFAULT_KEYS.has(key)) {
        return `capability.isolationDefaults 段未知配置项 "${key}"（可用：${[...ISOLATION_DEFAULT_KEYS].join(' / ')}）`;
      }
    }
    const trust = record['trustTier'];
    if (trust !== undefined && !TRUST_TIER_ORDER.includes(trust as never)) {
      return `capability.isolationDefaults.trustTier 取值非法："${String(trust)}"（可用：${TRUST_TIER_ORDER.join(' / ')}）`;
    }
    const isolation = record['isolation'];
    if (isolation !== undefined && !ISOLATION_LEVEL_ORDER.includes(isolation as never)) {
      return `capability.isolationDefaults.isolation 取值非法："${String(isolation)}"（可用：${ISOLATION_LEVEL_ORDER.join(' / ')}）`;
    }
    return undefined;
  }
}
