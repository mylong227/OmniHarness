/**
 * @beta
 * 插件可声明的权限范围（`域.动作`）。
 *
 * 已从 `plugin/permission.ts` 外迁到 ports 域：原文件退化为纯再导出桶，调用点零改动。
 */
export type PluginPermission =
  | 'fs.read'
  | 'fs.write'
  | 'fs.delete'
  | 'net.connect'
  | 'net.listen'
  | 'proc.exec'
  | 'env.read'
  | 'env.write'
  | 'store.read'
  | 'store.write';
