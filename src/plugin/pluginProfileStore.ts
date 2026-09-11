import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FileConfig } from '../config/configFile.js';
import type { PluginManager } from './pluginManager.js';
import type { PluginRegistry } from './pluginRegistry.js';
import { loadInstalledPlugins } from './pluginLoader.js';

/**
 * @beta
 * 插件集 Profile（G-E，对标 dsh 的 web/headless/coding 命名插件组合）。
 *
 * 与 `config/profile.ts` 的「配置分层 profile」（dev/ci/prod 覆盖 config 键）不同——
 * 此处是**命名插件组合**：一份 profile = 一串插件名，激活后即把 Agent 的运行时插件集
 * 收敛为该集合，实现「一条命令切换编码/研究模式插件集」。
 */
export interface PluginProfile {
  /** 展示名（也用于生成文件名 id）。 */
  readonly name: string;
  /** 简介（可选）。 */
  readonly description?: string;
  /** 激活时应当加载的插件名列表（顺序无关）。 */
  readonly plugins: readonly string[];
  /** 可选 config 覆盖层（激活时浅合并进运行时配置，fail-closed 校验）。 */
  readonly config?: Record<string, unknown>;
}

/**
 * @beta
 * 列表摘要。
 */
export interface PluginProfileSummary {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly pluginCount: number;
}

/**
 * @beta
 * 激活结果。
 */
export interface ApplyProfileResult {
  /** 本次新加载的插件。 */
  readonly activated: string[];
  /** 本次卸载的插件。 */
  readonly deactivated: string[];
  /** 因 profile 引用而新安装的插件。 */
  readonly installed: string[];
  /** 无法解析（未找到/安装失败）的插件名。 */
  readonly missing: string[];
}

/**
 * @beta
 * 激活选项（事件回调，便于 UI/RPC 实时反馈）。
 */
export interface ApplyProfileOptions {
  readonly onInstall?: (name: string) => void;
  readonly onLoad?: (name: string) => void;
  readonly onUnload?: (name: string) => void;
  readonly onError?: (name: string, error: unknown) => void;
}

/**
 * @beta
 * 把 profile.config 覆盖层合并进基础配置（浅合并 key 级），并重新严格校验。
 * 用于 CLI `--profile` / serve 启动时把 profile 的配置意图落到运行时。
 */
export function mergeProfileConfig(base: FileConfig, profile: PluginProfile): FileConfig {
  const overlay = profile.config ?? {};
  const merged = { ...base, ...overlay } as Record<string, unknown>;
  // 校验交给调用方 normalizeConfig；此处仅做浅合并，保留类型给 ConfigFactory。
  return merged as unknown as FileConfig;
}

/**
 * @beta
 * 文件名归一化（同 GraphStore 策略）。
 */
export function sanitizeProfileName(name: string): string {
  const id = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return id === '' ? 'unnamed' : id;
}

/**
 * @beta
 * 插件集 Profile 持久化（落 `<workspace>/.omniharness/pluginProfiles/<id>.json`）。
 * 与 GraphStore 同范式：list/get/save/delete + 不可解析文件在 list 中跳过（fail-closed 不阻塞）。
 */
export class PluginProfileStore {
  public constructor(private readonly workspaceRoot: string) {}

  private dir(): string {
    return join(this.workspaceRoot, '.omniharness', 'pluginProfiles');
  }

  /** 列出全部 profile 摘要（按文件名排序，坏文件跳过不阻塞）。 */
  public list(): PluginProfileSummary[] {
    const dir = this.dir();
    if (!existsSync(dir)) {
      return [];
    }
    const out: PluginProfileSummary[] = [];
    for (const file of readdirSync(dir).sort()) {
      if (!file.endsWith('.json')) {
        continue;
      }
      const parsed = this.readRaw(join(dir, file));
      if (parsed === undefined) {
        continue;
      }
      out.push({
        id: file.replace(/\.json$/, ''),
        name: parsed.name,
        description: parsed.description,
        pluginCount: parsed.plugins.length,
      });
    }
    return out;
  }

  /** 按 id 取完整 profile；不存在返回 undefined。 */
  public get(id: string): PluginProfile | undefined {
    const parsed = this.readRaw(join(this.dir(), `${id}.json`));
    if (parsed === undefined) {
      return undefined;
    }
    return parsed;
  }

  /** 保存/更新 profile；返回归一化 id。缺 name/plugins 即抛错（fail-closed）。 */
  public save(profile: PluginProfile): string {
    if (typeof profile.name !== 'string' || profile.name.trim() === '') {
      throw new Error('profile 必须包含 name');
    }
    if (!Array.isArray(profile.plugins)) {
      throw new Error('profile 必须包含 plugins 数组');
    }
    const id = sanitizeProfileName(profile.name);
    const dir = this.dir();
    mkdirSync(dir, { recursive: true });
    const payload: PluginProfile = {
      name: profile.name,
      plugins: [...profile.plugins],
      ...(profile.description !== undefined ? { description: profile.description } : {}),
      ...(profile.config !== undefined ? { config: profile.config } : {}),
    };
    writeFileSync(join(dir, `${id}.json`), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return id;
  }

  /** 删除；不存在返回 false。 */
  public delete(id: string): boolean {
    const path = join(this.dir(), `${id}.json`);
    if (!existsSync(path)) {
      return false;
    }
    rmSync(path, { force: true });
    return true;
  }

  /** 读取并宽松校验单个文件；不可解析返回 undefined（list 跳过）。 */
  private readRaw(path: string): PluginProfile | undefined {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      if (typeof raw.name !== 'string' || !Array.isArray(raw.plugins)) {
        return undefined;
      }
      return {
        name: raw.name,
        plugins: raw.plugins.filter((p): p is string => typeof p === 'string'),
        ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
        ...(raw.config !== undefined && typeof raw.config === 'object'
          ? { config: raw.config as Record<string, unknown> }
          : {}),
      };
    } catch {
      return undefined;
    }
  }
}

/**
 * 激活插件集 Profile：把运行时插件集收敛为 profile 指定的集合。
 *
 * 步骤（幂等、fail-closed）：
 * 1. 确保每个 profile 插件已安装（缺失则尝试从 registry 安装；找不到即记入 missing 并抛错）。
 * 2. 卸载当前已加载但不在 profile 中的插件（精准回收其工具，见 PluginManager）。
 * 3. 加载 profile 中尚未加载的插件（按 only 白名单，避免触碰其余已安装插件）。
 *
 * @returns 激活结果（含缺失项）；若 profile 引用了无法解析的插件，抛出含清单的错误。
 */
export async function applyProfile(
  manager: PluginManager,
  pluginsDir: string,
  registry: PluginRegistry,
  profile: PluginProfile,
  options?: ApplyProfileOptions,
): Promise<ApplyProfileResult> {
  const targetSet = new Set(profile.plugins);
  const installed: string[] = [];
  const missing: string[] = [];

  // 1) 确保安装
  for (const name of profile.plugins) {
    if (manager.names().includes(name)) {
      continue;
    }
    const dir = join(pluginsDir, name);
    const alreadyOnDisk = existsSync(join(dir, 'omni.plugin.json'));
    if (!alreadyOnDisk) {
      try {
        await registry.install(name);
        installed.push(name);
        options?.onInstall?.(name);
      } catch (error) {
        missing.push(name);
        options?.onError?.(name, error);
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(`无法激活 profile "${profile.name}"：以下插件无法解析：${missing.join(', ')}`);
  }

  // 2) 卸载非目标插件
  const deactivated: string[] = [];
  for (const name of [...manager.names()]) {
    if (!targetSet.has(name)) {
      await manager.uninstall(name);
      deactivated.push(name);
      options?.onUnload?.(name);
    }
  }

  // 3) 加载目标中尚未加载的插件（only 白名单，避免重触其余已安装插件）
  const toLoad = profile.plugins.filter((name) => !manager.names().includes(name));
  const activated: string[] =
    toLoad.length === 0
      ? []
      : await loadInstalledPlugins(manager, pluginsDir, options?.onError, toLoad);
  for (const name of activated) {
    options?.onLoad?.(name);
  }

  return { activated, deactivated, installed, missing };
}
