import type { PluginPermission } from './pluginPermission.js';

/**
 * @beta
 * 插件元信息。
 *
 * 已从 `plugin/plugin.ts` 外迁到 ports 域：原文件退化为纯再导出桶，调用点零改动。
 */
export interface PluginMeta {
  readonly name: string;
  readonly inject?: readonly string[] | undefined;
  /** 插件声明的权限（需在白名单内才允许注册启动，缺省=无能力声明）。 */
  readonly permissions?: readonly PluginPermission[] | undefined;
}
