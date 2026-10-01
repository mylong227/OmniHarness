import type { ContainerPort } from '../runtime/containerPort.js';

/**
 * @beta
 * 插件运行时上下文。
 *
 * 原先 `services: Container` 引用 `core.Container` 触发 `ports→core` 被禁边，现改为引用 ports 层
 * `ContainerPort`，契约外迁至 `ports/plugin`；原 `plugin/pluginApplyContext.ts` 退化为纯再导出桶，
 * 对外 API 面不变（`plugin/plugin.ts`、`ports/plugin/plugin.ts`、`index.ts` 等调用点零改动）。
 */
export interface PluginApplyContext {
  /** 服务容器（端口实现注册表），插件据此取用宿主能力。 */
  readonly services: ContainerPort;
  /** 订阅服务就绪：已注册立即回调，否则挂起等待。 */
  onService(name: string, handler: (service: unknown) => void): void;
  /** 注册一个插件提供的服务。 */
  registerService(name: string, service: unknown): void;
}
