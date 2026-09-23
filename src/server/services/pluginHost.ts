import type { ResolvedConfig } from '../../config/configFactory.js';
import { Container } from '../../core/container.js';
import { ServiceKeys } from '../../composition/runtime.js';
import { PluginManager } from '../../plugin/pluginManager.js';
import { loadInstalledPlugins } from '../../plugin/pluginLoader.js';
import { PermissionGate } from '../../plugin/permissionGate.js';
import { ALL_PERMISSIONS } from '../../plugin/permission.js';
import {
  applyProfile,
  type PluginProfile,
  type ApplyProfileResult,
} from '../../plugin/pluginProfileStore.js';
import type { PluginRegistry } from '../../plugin/pluginRegistry.js';
import { jsonRpc } from '../core/jsonRpc.js';
import type { Transport } from '../transport/lineTransport.js';

/** 插件宿主依赖。 */
export interface PluginHostDeps {
  /** 插件安装目录（undefined 表示插件系统未启用）。 */
  readonly pluginsDir: string | undefined;
  /** 基础解析配置（取其标准端口实例装进插件容器）；切换工作区后实时求值。 */
  readonly baseConfig: () => ResolvedConfig;
  /** JSON-RPC 传输（plugin.* 通知）。 */
  readonly transport: Transport;
  /** 插件注册表（未注入则不暴露市场能力）。 */
  readonly registry: PluginRegistry | undefined;
  /** 错误消息提取（复用 server 的统一口径）。 */
  readonly messageOf: (error: unknown) => string;
}

/**
 * 插件宿主：负责插件容器装配、已安装插件加载（幂等）与插件集 Profile 应用。
 *
 * 容器复用与 Agent 相同的标准端口实例，故插件注册进 `port.tools` 即对 Agent 可见。
 * 加载/应用的失败一律降级为 `plugin.loadError` / `profile.error` 通知，不抛出中断启动。
 */
export class PluginHost {
  /** 宿主依赖（插件目录、配置来源、传输、注册表与错误口径）。 */
  private readonly deps: PluginHostDeps;
  /** 插件容器管理器（ensure 后就绪；未启用目录时保持 undefined）。 */
  private pluginManager?: PluginManager;
  /** 插件加载是否已尝试（幂等保护，避免重复初始化）。 */
  private ready = false;

  /**
   * @param deps 插件目录、配置来源、传输、注册表与错误口径
   */
  public constructor(deps: PluginHostDeps) {
    this.deps = deps;
  }

  /** 插件管理器；未配置目录或尚未初始化时为 undefined。 */
  public get manager(): PluginManager | undefined {
    return this.pluginManager;
  }

  /** 插件安装目录。 */
  public get dir(): string | undefined {
    return this.deps.pluginsDir;
  }

  /**
   * 启动阶段加载已安装插件（闭环 G-B：市场安装 → 运行时可用）。
   * @returns 加载完成后 resolve，无载荷（失败降级为 plugin.loadError 通知）。
   */
  public async load(): Promise<void> {
    await this.ensure();
  }

  /**
   * 初始化插件容器并加载已安装插件（幂等）。
   * @returns 就绪后 resolve，无载荷。
   */
  public async ensure(): Promise<void> {
    if (this.ready) {
      return;
    }
    this.ready = true;
    const pluginsDir = this.deps.pluginsDir;
    if (pluginsDir === undefined) {
      return;
    }
    try {
      const config = this.deps.baseConfig();
      const container = new Container();
      container.register(ServiceKeys.model, config.model);
      container.register(ServiceKeys.tools, config.tools);
      container.register(ServiceKeys.storage, config.storage);
      container.register(ServiceKeys.events, config.events);
      container.register(ServiceKeys.sandbox, config.sandbox);
      container.register(ServiceKeys.approvals, config.approvals);
      const manager = new PluginManager(container, PermissionGate.fromList(ALL_PERMISSIONS));
      this.pluginManager = manager;
      const loaded = await loadInstalledPlugins(manager, pluginsDir, (name, error) =>
        this.notifyLoadError({ name, error: this.deps.messageOf(error) }),
      );
      if (loaded.length > 0) {
        this.deps.transport.send(jsonRpc.notify('plugin.loaded', { names: loaded }));
      }
    } catch (error) {
      this.notifyLoadError({ error: this.deps.messageOf(error) });
    }
  }

  /**
   * 应用插件集 Profile（CLI --plugin-profile / 编程入口复用本方法）。
   * @param profile 目标插件集
   * @returns 应用结果（安装/加载/卸载明细）
   */
  public async applyProfile(profile: PluginProfile): Promise<ApplyProfileResult> {
    await this.ensure();
    const registry = this.deps.registry;
    const manager = this.pluginManager;
    const pluginsDir = this.deps.pluginsDir;
    if (registry === undefined || manager === undefined || pluginsDir === undefined) {
      throw new Error('插件系统未初始化（serve 需注入 registry/pluginsDir）');
    }
    return applyProfile(manager, pluginsDir, registry, profile, {
      onInstall: (name) => this.notifyProfile('install', name),
      onLoad: (name) => this.notifyProfile('load', name),
      onUnload: (name) => this.notifyProfile('unload', name),
      onError: (name, error) =>
        this.deps.transport.send(
          jsonRpc.notify('profile.error', { name, error: this.deps.messageOf(error) }),
        ),
    });
  }

  /**
   * 发送 plugin.loadError 通知（name 缺省时不带该字段）。
   * @param payload `{ name?, error }` — 出错插件名与错误描述。
   * @returns 无返回值。
   */
  private notifyLoadError(payload: { name?: string; error: string }): void {
    const body: Record<string, string> = { error: payload.error };
    if (payload.name !== undefined) {
      body['name'] = payload.name;
    }
    this.deps.transport.send(jsonRpc.notify('plugin.loadError', body));
  }

  /**
   * 发送 profile.event 通知。
   * @param type 事件类型（install / load / unload）。
   * @param name 插件名。
   * @returns 无返回值。
   */
  private notifyProfile(type: 'install' | 'load' | 'unload', name: string): void {
    this.deps.transport.send(jsonRpc.notify('profile.event', { type, name }));
  }
}
