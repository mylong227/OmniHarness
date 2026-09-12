import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { manifestMatches, type PluginDescriptor, type PluginManifest } from './manifest.js';
import type { RegistrySource } from './registrySourcesShared.js';

/**
 * @beta
 * 本地 catalog 占位源：读取仓库内（或任意路径）的 `registry.json`，
 * 作为离线可用的「远程 registry 占位服务」。
 *
 * 与 RemoteHttpSource 同 schema（`{ plugins: [...] }`），但数据来自文件，
 * 离线稳定、可被用户直接编辑以扩展市场，而无需改代码。
 * 这是「真实 registry 占位服务」的落地：换一个可达的 HTTP 索引即可无缝升级为远程。
 */
export class FileRegistrySource implements RegistrySource {
  /** 源类型：归为 remote——本源是远程 registry 的离线占位（数据来自本地文件而非 HTTP）。 */
  public readonly kind = 'remote' as const;

  public constructor(
    private readonly catalogPath: string,
    private readonly baseDir: string = dirname(catalogPath),
  ) {}

  /**
   * 按查询过滤本地 catalog（registry.json）中的插件；文件缺失/损坏等任何读取失败
   * 都降级为空数组（离线不致命）。
   * @param query 查询子串（按名称/描述大小写不敏感匹配；undefined = 返回全量）
   * @returns 命中的插件描述符列表（读取失败时为空数组）
   */
  public async search(query?: string): Promise<PluginDescriptor[]> {
    const all = await this.catalog();
    return query === undefined ? all : all.filter((d) => manifestMatches(query, d.manifest));
  }

  /** 按唯一名取 catalog 中的插件（文件缺失/解析失败/不存在均返回 undefined）。 */
  public async get(name: string): Promise<PluginDescriptor | undefined> {
    return (await this.catalog()).find((d) => d.manifest.name === name);
  }

  /** 读取并解析 catalog；任何失败都降级为空数组（离线/缺文件不致命）。 */
  private async catalog(): Promise<PluginDescriptor[]> {
    try {
      if (!existsSync(this.catalogPath)) {
        return [];
      }
      const payload = JSON.parse(readFileSync(this.catalogPath, 'utf8')) as { plugins?: unknown };
      const plugins = payload.plugins;
      if (!Array.isArray(plugins)) {
        return [];
      }
      const out: PluginDescriptor[] = [];
      for (const item of plugins as Array<
        PluginManifest & { downloadUrl?: string; localPath?: string }
      >) {
        if (typeof item?.name !== 'string' || typeof item?.version !== 'string') {
          continue;
        }
        const { localPath, downloadUrl, ...manifest } = item;
        if (localPath !== undefined) {
          out.push({
            manifest,
            installFrom: { kind: 'path', path: resolve(this.baseDir, localPath) },
            source: 'remote',
          });
          continue;
        }
        out.push({
          manifest,
          installFrom: { kind: 'url', url: downloadUrl ?? this.catalogPath },
          source: 'remote',
        });
      }
      return out;
    } catch {
      return [];
    }
  }
}
