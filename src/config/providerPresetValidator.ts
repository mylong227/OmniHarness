import type { FileConfig } from './configFile.js';
import { providerPresets } from './providerPresets.js';

/**
 * `providerPresets` 配置段严格校验（fail-closed，2026-09-22 第二轮）。
 *
 * 为什么单独成类：`configError.ts` 是「一文件一类」形态，再塞一个校验类会越红线；而新顶层
 * `function` 又违反 D9。故与 `permissionConfigValidator` / `ssrfPolicyValidator` 同形：
 * 独立类 + 在 `configError` 的校验器表里以箭头注册项接入。
 *
 * 返回值约定：返回**错误消息字符串**（合法则 `undefined`）而非抛 `ConfigError`——
 * 本模块因此无需 import `configError.ts` 的值，从根上避免循环依赖。
 *
 * 与运行时同源：内容校验直接复用运行时同一个求解器（`providerPresets.resolve`），
 * 不另写一套字段规则，避免出现「配置层说合法、运行时却抛错（或反之）」的双口径。
 */
export class ProviderPresetValidator {
  /**
   * 校验 `FileConfig.providerPresets`：结构 → 逐条内容（同一套字段规则）。
   * @param cfg 已归一化的分层配置。
   * @returns 首个错误消息；全部合法时返回 undefined。
   */
  public validate(cfg: FileConfig): string | undefined {
    const raw = (cfg as Record<string, unknown>).providerPresets;
    if (raw === undefined) {
      return undefined;
    }
    if (!Array.isArray(raw)) {
      return 'providerPresets 应为数组（厂商预设列表；按 id 整体替换内建目录，新 id 追加）';
    }
    try {
      // 复用运行时求解器做逐条校验（非法条目一律抛错，不静默丢弃——静默丢弃会让 UI/CLI 少一家厂商而无提示）。
      providerPresets.resolve(raw as Parameters<typeof providerPresets.resolve>[0]);
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
}

/** 默认无状态实例（调用点以 `providerPresetValidator.validate` 零构造复用）。 */
export const providerPresetValidator = new ProviderPresetValidator();
