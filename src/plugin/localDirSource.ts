import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { manifestMatches, type PluginDescriptor, type PluginManifest } from './manifest.js';
import { readManifest, safeReaddir, type RegistrySource } from './registrySourcesShared.js';

/**
 * @beta
 * 已安装插件源：扫描 pluginsDir 下各子目录的 omni.plugin.json。
 */
export class LocalDirSource implements RegistrySource {
  /** 源类型：本地已安装目录（local），扫描 pluginsDir 实时得出。 */
  public readonly kind = 'local' as const;

  public constructor(private readonly dir: string) {}

  /**
   * 扫描 pluginsDir 下各子目录的 omni.plugin.json 并按查询过滤；目录不存在或子目录
   * 缺清单的条目直接跳过（与其他源不同：逐条读盘，结果反映当前已安装状态）。
   * @param query 查询子串（按名称/描述大小写不敏感匹配；undefined = 返回全量）
   * @returns 命中的已安装插件描述符（installFrom 为子目录本地路径）
   */
  public async search(query?: string): Promise<PluginDescriptor[]> {
    const out: PluginDescriptor[] = [];
    for (const entry of safeReaddir(this.dir)) {
      const manifestPath = join(this.dir, entry, 'omni.plugin.json');
      if (!existsSync(manifestPath)) {
        continue;
      }
      const manifest = readManifest(manifestPath);
      if (query !== undefined && !manifestMatches(query, manifest)) {
        continue;
      }
      out.push({
        manifest,
        installFrom: { kind: 'path', path: join(this.dir, entry) },
        source: 'local',
      });
    }
    return out;
  }

  /** 按唯一名取已安装插件（内部先全量扫描再按名匹配，不存在返回 undefined）。 */
  public async get(name: string): Promise<PluginDescriptor | undefined> {
    return (await this.search()).find((d) => d.manifest.name === name);
  }
}
