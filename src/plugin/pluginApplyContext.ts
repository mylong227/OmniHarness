// `PluginApplyContext` 契约已外迁至 `ports/plugin/pluginApplyContext.ts`，其 `services` 现引用 ports 层
// `ContainerPort`（不再依赖 core 实现），解除 `ports→core` 禁边；此处仅再导出以维持公共 API 面零改动。
export type { PluginApplyContext } from '../ports/plugin/pluginApplyContext.js';
