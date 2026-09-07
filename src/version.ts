/**
 * 公开 API 版本契约（@public）。
 *
 * 语义化版本约定：
 * - 次版本号 bump 代表新增 @public API；
 * - @beta API 的增删改不触发版本号变更（实验性，随时可能调整）；
 * - @deprecated API 在某个次版本标记，至少保留一个次版本后移除。
 */
export const API_VERSION = '0.1.0' as const;

/** API 版本字面量类型，供调用方做编译期契约断言。 */
export type ApiVersion = typeof API_VERSION;
