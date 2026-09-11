import { manifestMatches, type PluginDescriptor, type PluginManifest } from './manifest.js';
import { httpsJson, type RemoteFetcher, type RegistrySource } from './registrySourcesShared.js';

/**
 * @beta
 * 远程 registry 源：不可达/非 JSON 时优雅降级为空，不影响本地与打包源。
 */
export class RemoteHttpSource implements RegistrySource {
  public readonly kind = 'remote' as const;

  /** @param indexUrl 索引地址 @param fetcher 可注入拉取器（测试用） */
  public constructor(
    private readonly indexUrl: string,
    private readonly fetcher: RemoteFetcher = httpsJson,
  ) {}

  public async search(query?: string): Promise<PluginDescriptor[]> {
    const all = await this.index();
    return query === undefined ? all : all.filter((d) => manifestMatches(query, d.manifest));
  }

  public async get(name: string): Promise<PluginDescriptor | undefined> {
    return (await this.index()).find((d) => d.manifest.name === name);
  }

  /** 拉取索引；任何失败都降级为空数组（离线可用是硬要求）。 */
  private async index(): Promise<PluginDescriptor[]> {
    try {
      const payload = await this.fetcher(this.indexUrl);
      const plugins = (payload as { plugins?: unknown }).plugins;
      if (!Array.isArray(plugins)) {
        return [];
      }
      const out: PluginDescriptor[] = [];
      for (const item of plugins as Array<PluginManifest & { downloadUrl?: string }>) {
        if (typeof item?.name !== 'string' || typeof item?.version !== 'string') {
          continue;
        }
        out.push({
          manifest: item,
          installFrom: { kind: 'url', url: item.downloadUrl ?? this.indexUrl },
          source: 'remote',
        });
      }
      return out;
    } catch {
      return [];
    }
  }
}
