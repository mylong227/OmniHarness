/**
 * `ssrfPolicy` 配置段严格校验（fail-closed，2026-09-22）。
 *
 * 为什么单独成类：`configError.ts` 是「一文件一类」形态（`ConfigError`），再塞一个校验类会越红线；
 * 而新顶层 `function` 又违反 D9。故与 `permissionConfigValidator` 同形：独立类 + 注册项接入。
 *
 * 返回值约定：返回**错误消息字符串**（合法则 `undefined`）而非抛 `ConfigError`——
 * 本模块因此无需 import `configError.ts` 的值，从根上避免 `configError ↔ 本模块` 的循环依赖。
 */

import type { FileConfig } from './configFile.js';
import { SsrfPolicy } from '../security/ssrfPolicy.js';

/** `ssrfPolicy` 段允许的 key 全集。 */
const SSRF_POLICY_KEYS: ReadonlySet<string> = new Set([
  'metadataHosts',
  'internalSuffixes',
  'ipv4Blocks',
]);

/** ssrfPolicy 配置段校验器（无状态，可并发复用）。 */
export class SsrfPolicyValidator {
  /**
   * 校验 `FileConfig.ssrfPolicy`：结构 → 未知 key → 逐条内容（主机/后缀/CIDR）。
   *
   * 内容校验**复用运行时同一个解析器**（`resolveSsrfPolicy`）：校验与装配的口径必须同源，
   * 否则会出现「配置层说合法、运行时却抛错（或反之）」的双口径。
   * @param cfg 已归一化的分层配置。
   * @returns 首个错误消息；全部合法时返回 undefined。
   */
  public validate(cfg: FileConfig): string | undefined {
    const raw = (cfg as Record<string, unknown>).ssrfPolicy;
    if (raw === undefined) {
      return undefined;
    }
    if (!this.isPlainObject(raw)) {
      return 'ssrfPolicy 应为对象（{ metadataHosts?, internalSuffixes?, ipv4Blocks? }）';
    }
    for (const key of Object.keys(raw)) {
      if (!SSRF_POLICY_KEYS.has(key)) {
        return `ssrfPolicy 含未知 key '${key}'（允许：${[...SSRF_POLICY_KEYS].join(' / ')}）`;
      }
    }
    for (const key of ['metadataHosts', 'internalSuffixes', 'ipv4Blocks'] as const) {
      const value = (raw as Record<string, unknown>)[key];
      if (value !== undefined && !Array.isArray(value)) {
        return `ssrfPolicy.${key} 应为数组`;
      }
    }
    try {
      // 复用运行时解析器做逐条校验（非法条目一律抛错，不静默丢弃）。
      SsrfPolicy.resolveSsrfPolicy(raw as Parameters<typeof SsrfPolicy.resolveSsrfPolicy>[0]);
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * 是否普通对象（排除数组/null）——类型谓词，使调用点可直接按键取值。
   * @param value 待判值
   * @returns 是普通对象时为 true（并把类型收窄为 Record）
   */
  private isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}

/** 默认无状态实例（调用点以 `ssrfPolicyValidator.validate` 零构造复用）。 */
export const ssrfPolicyValidator = new SsrfPolicyValidator();
