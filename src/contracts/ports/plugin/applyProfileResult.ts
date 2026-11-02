/**
 * @beta
 * 激活结果。
 *
 * 已从 `plugin/pluginProfileStore.ts` 外迁到 ports 域：原文件退化为纯再导出桶，调用点零改动。
 */
export interface ApplyProfileResult {
  /** 本次新加载的插件。 */
  readonly activated: string[];
  /** 本次卸载的插件。 */
  readonly deactivated: string[];
  /** 因 profile 引用而新安装的插件。 */
  readonly installed: string[];
  /** 无法解析（未找到/安装失败）的插件名。 */
  readonly missing: string[];
}
