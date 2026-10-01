import type { Container } from '../core/container.js';

/**
 * @beta
 * 插件运行时上下文。
 *
 * 原与 `Plugin` / `PluginMeta` 同居于 `plugin/plugin.ts`。`Plugin` 外迁 ports 时，因本接口
 * 引用 `core.Container`（[3.5] 被禁方向，不能进 ports），故单独落此文件：既保留在 impl 层，
 * 又使 `plugin/plugin.ts` 桶不再与本接口同位，从而断开 `ports/plugin/plugin ↔ plugin/plugin`
 * 的潜在双向环。对外 API 面不变（`plugin/plugin.ts` 仍再导出本类型）。
 */
export interface PluginApplyContext {
  readonly services: Container;
  onService(name: string, handler: (service: unknown) => void): void;
  registerService(name: string, service: unknown): void;
}
