/**
 * `media` 配置段严格校验（fail-closed）。
 *
 * ## 校验与收敛的分工（为什么不是「越界就报错」）
 *
 * 两条不同的错必须分开对待：
 * - **写错了**（未知 key、类型不对、枚举取值不在集合内）：必须**拒绝启动**。
 *   这类错不会「大致可用」，只会静默失效——例如把 `maxFrames` 写成字符串 `'8'`
 *   （配置层不认 ⇒ 回落默认）或把键名写成 `max_frame`（一个都不生效），
 *   用户以为调过了、实际全是默认值，是最难查的配置错误。
 * - **取值偏大**（`maxFrames: 1000`）：不是错，是意图过头。这类由
 *   `MediaConfigResolver` **静默收敛**到安全区间，并在工具输出里回显生效值
 *   （报错拒绝启动对「只是想多给几帧」而言过重）。
 *
 * 故本类只做前者：结构 / 未知 key / 类型 / 枚举。数值范围**不在此拦**。
 *
 * ## 为什么单独成类
 *
 * `configError.ts` 是「一文件一类」形态（`ConfigError`），再塞一个校验类会越红线；
 * 新增顶层 `function` 又违反 D9。故与 `ssrfPolicyValidator` / `permissionConfigValidator`
 * 同形：独立类 + 一条注册项接入 `FIELD_VALIDATORS`。
 *
 * 返回值约定：返回**错误消息字符串**（合法则 `undefined`）而非抛 `ConfigError`——
 * 本模块因此无需 import `configError.ts` 的值，从根上避免 `configError ↔ 本模块` 的循环依赖。
 */

import type { FileConfig } from './configFile.js';

/** `media` 段允许的 key 全集（新增配置项必须同时加到 `MediaAnalysisConfig` 与本表）。 */
const MEDIA_KEYS: ReadonlySet<string> = new Set([
  'ffmpegPath',
  'ffprobePath',
  'maxFrames',
  'maxDimension',
  'maxFrameBytes',
  'maxTotalBytes',
  'maxInputBytes',
  'timeoutMs',
  'sceneThreshold',
  'videoFormat',
  'jpegQuality',
  'extraSearchPaths',
]);

/** 数值型 key（必须为有限数；范围由解析器收敛，不在此拦）。 */
const NUMERIC_KEYS: readonly string[] = [
  'maxFrames',
  'maxDimension',
  'maxFrameBytes',
  'maxTotalBytes',
  'maxInputBytes',
  'timeoutMs',
  'sceneThreshold',
  'jpegQuality',
];

/** 字符串型 key（非空字符串）。 */
const STRING_KEYS: readonly string[] = ['ffmpegPath', 'ffprobePath'];

/** `videoFormat` 允许取值。 */
const VIDEO_FORMATS: readonly string[] = ['jpeg', 'png'];

/** `media` 配置段校验器（无状态，可并发复用）。 */
export class MediaConfigValidator {
  /**
   * 校验 `FileConfig.media`：结构 → 未知 key → 逐字段类型 → 枚举。
   *
   * @param cfg 已归一化的分层配置。
   * @returns 首个错误消息；全部合法时返回 `undefined`。
   */
  public validate(cfg: FileConfig): string | undefined {
    const raw = (cfg as Record<string, unknown>)['media'];
    if (raw === undefined) {
      return undefined;
    }
    if (!MediaConfigValidator.isPlainObject(raw)) {
      return 'media 应为对象（见 docs 的 media 段字段表：maxFrames / maxDimension / ffmpegPath …）';
    }
    for (const key of Object.keys(raw)) {
      if (!MEDIA_KEYS.has(key)) {
        return `media 含未知 key '${key}'（允许：${[...MEDIA_KEYS].join(' / ')}）`;
      }
    }
    for (const key of NUMERIC_KEYS) {
      const value = raw[key];
      if (value === undefined) {
        continue;
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return `media.${key} 应为有限数（收到 ${MediaConfigValidator.describe(value)}）`;
      }
    }
    for (const key of STRING_KEYS) {
      const value = raw[key];
      if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
        return `media.${key} 应为非空字符串路径（收到 ${MediaConfigValidator.describe(value)}）`;
      }
    }
    const format = raw['videoFormat'];
    if (format !== undefined && !VIDEO_FORMATS.includes(format as string)) {
      return `media.videoFormat 只能是 ${VIDEO_FORMATS.join(' / ')}（收到 ${MediaConfigValidator.describe(format)}）`;
    }
    const extra = raw['extraSearchPaths'];
    if (extra !== undefined) {
      if (!Array.isArray(extra)) {
        return 'media.extraSearchPaths 应为字符串数组（追加的二进制搜索目录）';
      }
      for (const entry of extra) {
        if (typeof entry !== 'string' || entry.trim() === '') {
          return `media.extraSearchPaths 含非法条目 ${MediaConfigValidator.describe(entry)}（须为非空字符串）`;
        }
      }
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

/** 默认无状态实例（调用点以 `mediaConfigValidator.validate` 零构造复用）。 */
export const mediaConfigValidator = new MediaConfigValidator();
