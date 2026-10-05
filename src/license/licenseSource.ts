/**
 * 授权来源解析（**F4 的取数面**：把"这台机器现在是什么档"从 CLI 参数变成产品路径可用的裁决）。
 *
 * ## 为什么用环境变量而不是新配置段
 *
 * license 文本与验签公钥属**凭据**（像 token / 私钥），本仓既有纪律是凭据走 `credentialResolver`
 * 与环境变量、**不落进可提交的 config 文件**——配置段会被人复制进仓库，凭据不会（也不该）。
 * 故本模块读：
 * - `OMNI_LICENSE`（内联文本）或 `OMNI_LICENSE_FILE`（文件路径，二选一，后者优先）；
 * - `OMNI_LICENSE_PUBLIC_KEY`（`ssh-ed25519 …` 验签根）。
 *
 * ## 四条口径
 *
 * 1. **缺即 core**：没配就按 `core` 档走（不是错误），功能闸门各自给出"需要哪一档"；
 * 2. **配了但不可采信 ⇒ 同样 core，且必须留痕**：`license.source.rejected` 事件带**授权拒因码**，
 *    否则"我明明配了 license 却用不了"只能靠猜；
 * 3. **文件有硬上限**（缺省 64 KiB）：license 是一段文本，给它一个上限是边界纪律（§12.1-3）；
 * 4. **不抛异常**：解析失败一律降级为 core（与 F1"过期不停摆"同一口径），
 *    因为"授权问题"绝不该让 harness 起不来。
 *
 * @maturity L1 — 无配置 / 内联有效 / 文件优先 / 超限拒 / 验签失败降级 + 事件 判据钉死
 * @maturityEvidence tests/unit/licenseSource.test.ts
 */
import { readFileSync, statSync } from 'node:fs';

import { LicenseEngine } from './licenseEngine.js';
import { FeatureEntitlements } from './featureEntitlements.js';
import { log } from '../util/logger.js';
import type { EntitlementObserver } from './featureEntitlements.js';

/** 内联 license 的环境变量名。 */
export const LICENSE_ENV_TEXT = 'OMNI_LICENSE';
/** license 文件路径的环境变量名（与内联同时存在时**优先**）。 */
export const LICENSE_ENV_FILE = 'OMNI_LICENSE_FILE';
/** 验签公钥的环境变量名。 */
export const LICENSE_ENV_PUBLIC_KEY = 'OMNI_LICENSE_PUBLIC_KEY';

/** license 文件字节上限（缺省 64 KiB）。 */
const DEFAULT_MAX_LICENSE_BYTES = 64 * 1024;

/** 解析入参。 */
export interface LicenseSourceOptions {
  /** 环境变量表（显式注入，便于判据确定性）。 */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** 当前时刻（epoch ms；注入以便判据确定性）。 */
  readonly nowMs?: number | undefined;
  /** 本机机器指纹（缺省由 `machineFingerprint()` 求取）。 */
  readonly machineFingerprint?: string | undefined;
  /** license 文件字节上限（缺省 64 KiB）。 */
  readonly maxBytes?: number | undefined;
  /** 观测回调（缺省写共享 logger）。 */
  readonly observer?: EntitlementObserver | undefined;
}

/** 授权来源解析器。 */
export class LicenseSource {
  private constructor() {}

  /**
   * 解析本机授权 → 功能权益。
   * @param opts 环境与时刻
   * @returns 权益解析器（任何失败都降级为 core）
   */
  public static resolve(opts: LicenseSourceOptions): FeatureEntitlements {
    const observe = opts.observer ?? ((event, fields) => log.warn(event, fields));
    const publicKeySsh = opts.env[LICENSE_ENV_PUBLIC_KEY];
    const text = LicenseSource.readText(opts, observe);
    if (text === undefined || publicKeySsh === undefined || publicKeySsh.trim() === '') {
      // 未配置（或只配了一半）⇒ core。**半步配置也算未配置**：只配文本没配公钥无法验签，
      // 此时若"当作有效"就是最危险的那种放行。
      if (text !== undefined && (publicKeySsh === undefined || publicKeySsh.trim() === '')) {
        observe('license.source.rejected', { code: 'no-license', missing: LICENSE_ENV_PUBLIC_KEY });
      }
      return FeatureEntitlements.core(observe);
    }
    const verdict = LicenseEngine.verify({
      text,
      publicKeySsh,
      ...(opts.machineFingerprint !== undefined
        ? { machineFingerprint: opts.machineFingerprint }
        : { machineFingerprint: LicenseEngine.machineFingerprint() }),
      ...(opts.nowMs !== undefined ? { nowMs: opts.nowMs } : {}),
    });
    if (!verdict.ok && verdict.code === 'expired') {
      // 过期是**预期状态**（诚实降级），不是配置错误：走 info 级，别制造假告警。
      observe('license.source.expired', { tier: verdict.tier });
    } else if (!verdict.ok) {
      observe('license.source.rejected', { code: verdict.code ?? 'no-license' });
    }
    return new FeatureEntitlements({ verdict, observer: observe });
  }

  /**
   * 取 license 文本（文件优先；带字节上限；读失败按未配置并留痕）。
   * @param opts 解析入参
   * @param observe 观测回调
   * @returns 文本；未配置或不可读时 undefined
   */
  private static readText(
    opts: LicenseSourceOptions,
    observe: EntitlementObserver,
  ): string | undefined {
    const file = opts.env[LICENSE_ENV_FILE];
    if (file !== undefined && file.trim() !== '') {
      const maxBytes = Math.max(1, Math.floor(opts.maxBytes ?? DEFAULT_MAX_LICENSE_BYTES));
      try {
        const size = statSync(file).size;
        if (size > maxBytes) {
          // **先 stat 再读**：超限直接拒，而不是"读进来再判断"（大文件已经把内存吃掉了）。
          observe('license.source.rejected', { code: 'malformed', reason: 'size-limit', size });
          return undefined;
        }
        return readFileSync(file, 'utf8');
      } catch (err) {
        observe('license.source.rejected', {
          code: 'malformed',
          reason: err instanceof Error ? err.message : String(err),
        });
        return undefined;
      }
    }
    const inline = opts.env[LICENSE_ENV_TEXT];
    return inline !== undefined && inline.trim() !== '' ? inline : undefined;
  }
}
