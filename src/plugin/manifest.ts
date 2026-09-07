import { DANGEROUS_PERMISSIONS, isPluginPermission, type PluginPermission } from './permission.js';

/**
 * @beta
 * 插件清单（omni.plugin.json）。
 *
 * 吸收 DeepSeek Harness 的插件元数据思想，但字段自研、不引入 dsh 依赖。
 * 清单声明的权限必须在 `ALL_PERMISSIONS` 白名单内，否则安装/加载阶段 fail-closed 拒绝。
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

/**
 * @beta
 * registry 内流通的插件描述符。
 */
export interface PluginDescriptor {
  readonly manifest: PluginManifest;
  /** 安装来源：本地路径或远程下载 URL。 */
  readonly installFrom:
    | { readonly kind: 'path'; readonly path: string }
    | { readonly kind: 'url'; readonly url: string };
  /** 来源类型。 */
  readonly source: 'bundled' | 'local' | 'remote';
}

/**
 * @beta
 * 校验清单权限字符串是否全部合法；非法则抛错（fail-closed）。
 * 返回归一化后的 PluginPermission 列表。
 */
export function validateManifestPermissions(manifest: PluginManifest): PluginPermission[] {
  const perms: PluginPermission[] = [];
  for (const raw of manifest.permissions ?? []) {
    if (!isPluginPermission(raw)) {
      throw new Error(`插件 "${manifest.name}" 声明了未知权限: ${raw}（合法项见 ALL_PERMISSIONS）`);
    }
    perms.push(raw);
  }
  return perms;
}

/**
 * @beta
 * 清单是否含危险权限（用于安装时显式提示，非阻断）。
 */
export function manifestHasDangerous(manifest: PluginManifest): boolean {
  return (manifest.permissions ?? []).some((p) => DANGEROUS_PERMISSIONS.has(p as PluginPermission));
}

/**
 * @beta
 * 查询是否命中（名称/描述子串，大小写不敏感）。
 */
export function manifestMatches(query: string, manifest: PluginManifest): boolean {
  const q = query.toLowerCase();
  return (
    manifest.name.toLowerCase().includes(q) ||
    (manifest.description ?? '').toLowerCase().includes(q)
  );
}
