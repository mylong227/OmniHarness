import type { Container } from '../core/container.js';
import type { PluginPermission } from './permission.js';

/**
 * @beta
 * 插件元信息。
 */
export interface PluginMeta {
  readonly name: string;
  readonly inject?: readonly string[];
  /** 插件声明的权限（需在白名单内才允许注册启动，缺省=无能力声明）。 */
  readonly permissions?: readonly PluginPermission[];
}

/**
 * @beta
 * 插件运行时上下文。
 */
export interface PluginApplyContext {
  readonly services: Container;
  onService(name: string, handler: (service: unknown) => void): void;
  registerService(name: string, service: unknown): void;
}

/**
 * @beta
 * 插件：apply 启动 + effect 可逆清理（cordis-lite 语义）。
 */
export interface Plugin {
  readonly meta: PluginMeta;
  apply(context: PluginApplyContext): void | Promise<void>;
  effect?(): void | Promise<void>;
}
