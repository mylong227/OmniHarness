import type { PluginMeta } from './pluginMeta.js';
import type { PluginApplyContext } from '../../plugin/pluginApplyContext.js';

/**
 * @beta
 * 插件：apply 启动 + effect 可逆清理（cordis-lite 语义）。
 *
 * 已从 `plugin/plugin.ts` 外迁到 ports 域：原文件退化为纯再导出桶，调用点零改动。
 * `PluginMeta` 同迁至 `ports/plugin/pluginMeta.ts`；`PluginApplyContext` 因引用 `core.Container`
 * （属 [3.5] 被禁方向）保留在 `plugin/pluginApplyContext.ts`，由本端口经相对导入取用，
 * 避免 `ports↔impl` 双向环。
 */
export interface Plugin {
  readonly meta: PluginMeta;
  apply(context: PluginApplyContext): void | Promise<void>;
  effect?: (() => void | Promise<void>) | undefined;
}
