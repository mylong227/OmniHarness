import { resolve } from 'node:path';
import { manifestMatches, type PluginDescriptor } from './manifest.js';
import { type BundledPlugin } from './bundledRegistry.js';
import type { RegistrySource } from './registrySourcesShared.js';

/**
 * @beta
 * 打包内置源：仓库自带示范插件，离线可用。
 */
export class BundledSource implements RegistrySource {
  /** 源类型：打包内置（bundled），随仓库分发、离线可用。 */
  public readonly kind = 'bundled' as const;

  /** @param plugins 打包清单 @param baseDir localPath 的解析基准（通常仓库根） */
  public constructor(
    private readonly plugins: readonly BundledPlugin[],
    private readonly baseDir: string,
  ) {}

  /**
   * 按查询过滤内置插件（数据来自构造时注入的打包清单，纯内存转换，无 IO）。
   * @param query 查询子串（按名称/描述大小写不敏感匹配；undefined = 返回全量）
   * @returns 命中的插件描述符列表（含本地路径或下载地址的安装来源）
   */
  public async search(query?: string): Promise<PluginDescriptor[]> {
    const all = this.descriptors();
    return query === undefined ? all : all.filter((d) => manifestMatches(query, d.manifest));
  }

  /** 按唯一名取内置插件描述符（不存在返回 undefined）。 */
  public async get(name: string): Promise<PluginDescriptor | undefined> {
    return this.descriptors().find((d) => d.manifest.name === name);
  }

  /** 构造描述符：优先本地路径，其次下载地址。 */
  private descriptors(): PluginDescriptor[] {
    const out: PluginDescriptor[] = [];
    for (const plugin of this.plugins) {
      const { localPath, downloadUrl, ...manifest } = plugin;
      if (localPath !== undefined) {
        out.push({
          manifest,
          installFrom: { kind: 'path', path: resolve(this.baseDir, localPath) },
          source: 'bundled',
        });
        continue;
      }
      if (downloadUrl !== undefined) {
        out.push({ manifest, installFrom: { kind: 'url', url: downloadUrl }, source: 'bundled' });
      }
    }
    return out;
  }
}
