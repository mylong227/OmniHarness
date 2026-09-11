import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { manifestMatches, type PluginDescriptor, type PluginManifest } from './manifest.js';
import { readManifest, safeReaddir, type RegistrySource } from './registrySourcesShared.js';

/**
 * @beta
 * 已安装插件源：扫描 pluginsDir 下各子目录的 omni.plugin.json。
 */
export class LocalDirSource implements RegistrySource {
  public readonly kind = 'local' as const;

  public constructor(private readonly dir: string) {}

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

  public async get(name: string): Promise<PluginDescriptor | undefined> {
    return (await this.search()).find((d) => d.manifest.name === name);
  }
}
