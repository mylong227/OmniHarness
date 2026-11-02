import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Plugin } from './plugin.ts';
import type { PluginManifest } from './manifest.ts';
import type { PluginManager } from './pluginManager.ts';
import { RemotePlugin } from './worker/remotePlugin.ts';

/**
 * PluginLoader — 宿主类：收拢本模块原顶层内部函数（C7 顶层函数收敛），提供统一命名空间。
 */
export class PluginLoader {
  /**
   * 动态导入本地/内置可信插件。
   * @param {string} entryPath - entryPath
   * @returns {Promise<Plugin>} - result
   */
  public static async importPlugin(entryPath: string): Promise<Plugin> {
    const module = await import(pathToFileURL(entryPath).href);
    const plugin = module.default as Plugin | undefined;
    if (
      plugin === undefined ||
      plugin === null ||
      typeof plugin.apply !== 'function' ||
      typeof plugin.meta?.name !== 'string'
    ) {
      throw new Error('默认导出无效（需为 { meta, apply }）');
    }
    return plugin;
  }

  /**
   * 从清单读取元数据（entry / source）。
   * @param {string} manifestPath - manifestPath
   * @returns {Partial<PluginManifest>} - result
   */
  public static readManifest(manifestPath: string): Partial<PluginManifest> {
    try {
      return JSON.parse(readFileSync(manifestPath, 'utf8')) as Partial<PluginManifest>;
    } catch {
      return {};
    }
  }

  /**
   * 安全列目录（不存在返回空）。
   * @param {string} dir - dir
   * @returns {string[]} - result
   */
  public static safeReaddir(dir: string): string[] {
    return existsSync(dir) ? readdirSync(dir) : [];
  }

  /**
   * 是否允许加载**远程来源**的插件（默认禁止，需 `OMNI_ALLOW_REMOTE_PLUGINS=1` 显式放行）。
   *
   * 为什么默认禁止（2026-10-21）：VM 沙箱不是安全边界（宿主端口对象的方法仍带宿主
   * `Function`），而市场安装的远程插件是不可信代码。把「加载不可信代码」变成显式选择，
   * 默认只加载 bundled/local 这些同源可信插件；需要时由部署者一次性开启。
   * @param env 环境变量（测试可注入）。
   * @returns 允许远程插件时为 true。
   */
  public static remotePluginsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
    return env['OMNI_ALLOW_REMOTE_PLUGINS'] === '1';
  }

  /**
   * 扫 pluginsDir，逐个加载 entry 并 register 进 PluginManager。
   *
   * 设计要点（闭环 G-B 运行时加载）：
   * - 仅加载未注册过的插件（按目录名去重），重复调用幂等，不重复注册工具。
   * - **远程源插件默认不加载**（`source==='remote'`）：VM 只是纵深防御，不是安全边界；
   *   需 `OMNI_ALLOW_REMOTE_PLUGINS=1` 显式放行，放行后仍走受限 VM。
   * - 本地/内置源走普通动态 import（同源可信）。
   * - 单插件坏不影响其余：onError 回调上报，否则整轮抛错。
   * - 绑定到与 Agent 同一 `port.tools` 的容器时，插件 apply 内 `get('port.tools').register(...)`
   *   注册的工具直接进 Agent 工具表——这就是「市场安装 → 运行时可用」的闭环。
   *
   * @param only 仅加载指定插件名（Profile 激活子集用）；缺省加载全部已安装。
   * @returns 本次新加载的插件名列表。
   */
  public static async loadInstalledPlugins(
    manager: PluginManager,
    pluginsDir: string,
    onError?: (name: string, error: unknown) => void,
    only?: readonly string[],
    workspaceRoot?: string,
  ): Promise<string[]> {
    if (!existsSync(pluginsDir)) {
      return [];
    }
    const allow = only === undefined ? undefined : new Set(only);
    const remoteAllowed = PluginLoader.remotePluginsAllowed();
    const loaded: string[] = [];
    const existing = new Set(manager.names());
    for (const entry of PluginLoader.safeReaddir(pluginsDir)) {
      if (existing.has(entry)) {
        continue;
      }
      if (allow !== undefined && !allow.has(entry)) {
        continue;
      }
      const dir = join(pluginsDir, entry);
      const manifestPath = join(dir, 'omni.plugin.json');
      if (!existsSync(manifestPath)) {
        continue;
      }
      const manifest = PluginLoader.readManifest(manifestPath);
      const entryFile = manifest.entry ?? 'index.js';
      try {
        // 只有**显式声明** bundled/local 的插件才走宿主 import（同源可信）。
        // `remote` 默认拒绝加载（需 `OMNI_ALLOW_REMOTE_PLUGINS=1` 显式放行）；**缺失/损坏的 source** 按不可信
        // 处理但仍在 Worker 中加载——手工放进 pluginsDir 的本地插件通常不写 source，
        // 直接拒绝会把「本地开发插件」一并打死（2026-10-21 口径修正）。
        const trusted = manifest.source === 'bundled' || manifest.source === 'local';
        if (manifest.source === 'remote' && !remoteAllowed) {
          throw new Error(
            '远程插件默认不加载（需 Worker 进程隔离）；如确需加载请设 OMNI_ALLOW_REMOTE_PLUGINS=1',
          );
        }
        const plugin: Plugin = trusted
          ? await PluginLoader.importPlugin(join(dir, entryFile))
          : new RemotePlugin({
              name: manifest.name ?? entry,
              entryPath: join(dir, entryFile),
              ...(manifest.version !== undefined ? { version: manifest.version } : {}),
              ...(manifest.permissions !== undefined ? { permissions: manifest.permissions } : {}),
              ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
            });
        await manager.register(plugin);
        loaded.push(entry);
      } catch (error) {
        if (onError !== undefined) {
          onError(entry, error);
        } else {
          throw error;
        }
      }
    }
    return loaded;
  }
}
