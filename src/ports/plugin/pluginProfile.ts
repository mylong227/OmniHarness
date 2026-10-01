/**
 * @beta
 * 插件集 Profile（G-E，对标 dsh 的 web/headless/coding 命名插件组合）。
 *
 * 与 `config/profile.ts` 的「配置分层 profile」（dev/ci/prod 覆盖 config 键）不同——
 * 此处是**命名插件组合**：一份 profile = 一串插件名，激活后即把 Agent 的运行时插件集
 * 收敛为该集合，实现「一条命令切换编码/研究模式插件集」。
 *
 * 已从 `plugin/pluginProfileStore.ts` 外迁到 ports 域：原文件退化为纯再导出桶，调用点零改动。
 */
export interface PluginProfile {
  /** 展示名（也用于生成文件名 id）。 */
  readonly name: string;
  /** 简介（可选）。 */
  readonly description?: string;
  /** 激活时应当加载的插件名列表（顺序无关）。 */
  readonly plugins: readonly string[];
  /** 可选 config 覆盖层（激活时浅合并进运行时配置，fail-closed 校验）。 */
  readonly config?: Record<string, unknown>;
}
