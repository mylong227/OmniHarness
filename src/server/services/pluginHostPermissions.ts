/**
 * 服务端插件宿主的**权限白名单裁决**（2026-10-27 审计收口）。
 *
 * 此前宿主把白名单设成 `ALL_PERMISSIONS` 全集——`meta.permissions` 形同虚设：市场安装的
 * 插件天然拿到 `proc.exec` / `env.write` 等危险能力。改为**默认只授非危险权限**
 * （fs.read / net.connect / env.read / store.read），危险能力必须由操作者经
 * `OMNI_PLUGIN_PERMISSIONS` 环境变量显式授予（逗号分隔权限名，或 `all` 全开）。
 */
import { ALL_PERMISSIONS, DANGEROUS_PERMISSIONS, Permission } from '../../plugin/permission.ts';
import type { PluginPermission } from '../../plugin/permission.ts';
import { PermissionGate } from '../../plugin/permissionGate.ts';
import { log } from '../../util/logger.ts';

/** 宿主权限白名单的环境变量名（逗号分隔的额外授权，或 `all`）。 */
export const PLUGIN_PERMISSIONS_ENV = 'OMNI_PLUGIN_PERMISSIONS';

/**
 * 插件宿主权限白名单解析器（构造 `PermissionGate` 的唯一入口）。
 */
export class PluginHostPermissions {
  /**
   * 解析宿主权限门禁（环境覆盖只在调用期生效一次）。
   * @param env 环境变量源（测试可注入桩；缺省 `process.env`）。
   * @returns 权限门禁（默认 = 非危险全集 + 显式授予项）。
   */
  public static resolve(env: NodeJS.ProcessEnv = process.env): PermissionGate {
    const raw = (env[PLUGIN_PERMISSIONS_ENV] ?? '').trim();
    if (raw.toLowerCase() === 'all') {
      log.warn('plugin.host.permissions.all', { reason: `${PLUGIN_PERMISSIONS_ENV}=all 显式全开` });
      return PermissionGate.allowAll();
    }
    const granted: PluginPermission[] = [];
    for (const item of raw.split(',')) {
      const name = item.trim();
      if (name === '') continue;
      if (!Permission.isPluginPermission(name)) {
        log.warn('plugin.host.permissions.unknown', { name });
        continue;
      }
      granted.push(name);
    }
    if (granted.length > 0) {
      log.warn('plugin.host.permissions.granted', { granted });
    }
    return PermissionGate.fromList([...PluginHostPermissions.safe(), ...granted]);
  }

  /**
   * 非危险权限（默认白名单）。
   * @returns 权限名列表。
   */
  private static safe(): readonly PluginPermission[] {
    return ALL_PERMISSIONS.filter((name) => !DANGEROUS_PERMISSIONS.has(name));
  }
}
