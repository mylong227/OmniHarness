/**
 * @beta
 * 插件清单（omni.plugin.json）。
 *
 * 吸收 DeepSeek Harness 的插件元数据思想，但字段自研、不引入 dsh 依赖。
 * 清单声明的权限必须在 `ALL_PERMISSIONS` 白名单内，否则安装/加载阶段 fail-closed 拒绝。
 *
 * 已从 `plugin/manifest.ts` 外迁到 ports 域：原文件退化为纯再导出桶，调用点零改动。
 */
export interface PluginManifest {
  /** 唯一名（小写连字符，如 github-tools）。 */
  readonly name: string;
  /** 语义化版本。 */
  readonly version: string;
  /** 一句话描述。 */
  readonly description?: string;
  /** 作者。 */
  readonly author?: string;
  /** 主页/源码地址。 */
  readonly homepage?: string;
  /**
   * 声明权限（域.动作）。未声明=无能力。
   * 加载时经 PermissionGate 校验，超白名单即拒绝（fail-closed）。
   */
  readonly permissions?: readonly string[];
  /** 入口文件（相对插件目录），默认 index.js。 */
  readonly entry?: string;
  /** 来源标记，便于 UI/CLI 展示。 */
  readonly source?: 'bundled' | 'local' | 'remote';
}
