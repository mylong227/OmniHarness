/**
 * 插件权限模型：声明式权限 + 危险权限集。
 *
 * 插件通过 `meta.permissions` 声明其所需能力，`PermissionGate` 依白名单校验，
 * 未声明或超白名单的能力一律拒绝（fail-closed）。权限名采用 `域.动作` 两级命名。
 */

/**
 * @beta
 * 插件可声明的权限范围（`域.动作`）。
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

/**
 * @beta
 * 全部已知权限。
 */
export const ALL_PERMISSIONS: readonly PluginPermission[] = [
  'fs.read',
  'fs.write',
  'fs.delete',
  'net.connect',
  'net.listen',
  'proc.exec',
  'env.read',
  'env.write',
  'store.read',
  'store.write',
];

/**
 * @beta
 * 危险权限集：这些能力可导致数据破坏 / 任意代码执行 / 系统改动，
 * 默认应被拒，需明确加入白名单才放行。
 */
export const DANGEROUS_PERMISSIONS: ReadonlySet<PluginPermission> = new Set<PluginPermission>([
  'fs.write',
  'fs.delete',
  'net.listen',
  'proc.exec',
  'env.write',
  'store.write',
]);

/**
 * @beta
 * 权限名是否合法。
 */
export function isPluginPermission(value: string): value is PluginPermission {
  return (ALL_PERMISSIONS as readonly string[]).includes(value);
}
