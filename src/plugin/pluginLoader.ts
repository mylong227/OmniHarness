import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Plugin } from './plugin.js';
import type { PluginManifest } from './manifest.js';
import type { PluginManager } from './pluginManager.js';
import { loadPluginCodeInSandbox } from './sandbox.js';

/**
 * 扫 pluginsDir，逐个加载 entry 并 register 进 PluginManager。
 *
 * 设计要点（闭环 G-B 运行时加载）：
 * - 仅加载未注册过的插件（按目录名去重），重复调用幂等，不重复注册工具。
 * - **远程源插件（manifest.source==='remote'）走受限 VM 沙箱**（`loadPluginCodeInSandbox`），
 *   隔离不可信代码；本地/内置源走普通动态 import（同源可信）。
 * - 单插件坏不影响其余：onError 回调上报，否则整轮抛错。
 * - 绑定到与 Agent 同一 `port.tools` 的容器时，插件 apply 内 `get('port.tools').register(...)`
 *   注册的工具直接进 Agent 工具表——这就是「市场安装 → 运行时可用」的闭环。
 *
 * @param only 仅加载指定插件名（Profile 激活子集用）；缺省加载全部已安装。
 * @returns 本次新加载的插件名列表。
 */
export async function loadInstalledPlugins(
  manager: PluginManager,
  pluginsDir: string,
  onError?: (name: string, error: unknown) => void,
  only?: readonly string[],
): Promise<string[]> {
  if (!existsSync(pluginsDir)) {
    return [];
  }
  const allow = only === undefined ? undefined : new Set(only);
  const loaded: string[] = [];
  const existing = new Set(manager.names());
  for (const entry of safeReaddir(pluginsDir)) {
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
    const manifest = readManifest(manifestPath);
    const entryFile = manifest.entry ?? 'index.js';
    try {
      // 远程源（来自 catalog/远程 registry 的不可信插件）→ 受限 VM 沙箱隔离加载。
      const plugin: Plugin =
        manifest.source === 'remote'
          ? loadPluginCodeInSandbox(
              readFileSync(join(dir, entryFile), 'utf8'),
              join(dir, entryFile),
            )
          : await importPlugin(join(dir, entryFile));
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

/** 动态导入本地/内置可信插件。 */
async function importPlugin(entryPath: string): Promise<Plugin> {
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

/** 从清单读取元数据（entry / source）。 */
function readManifest(manifestPath: string): Partial<PluginManifest> {
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8')) as Partial<PluginManifest>;
  } catch {
    return {};
  }
}

/** 安全列目录（不存在返回空）。 */
function safeReaddir(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : [];
}
