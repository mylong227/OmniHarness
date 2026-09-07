import type { Container } from '../core/container.js';
import type { Plugin, PluginApplyContext } from './plugin.js';
import type { PermissionGate } from './permissionGate.js';
import type { ToolPort } from '../ports/tool.js';

/**
 * @beta
 * 插件管理器：注册/启动/卸载；依赖注入"就绪后再启动"，effect 逆序清理。
 */
export class PluginManager {
  private readonly plugins = new Map<string, Plugin>();
  private readonly started = new Set<string>();
  private readonly starting = new Set<string>();
  private readonly pending = new Map<string, ((service: unknown) => void)[]>();
  /** 记录每个插件 apply 期间注册的工具名（用于卸载时精准回收，避免孤儿工具残留）。 */
  private readonly pluginTools = new Map<string, Set<string>>();

  /**
   * @param container 服务容器
   * @param gate 可选权限门禁；提供则注册时校验插件声明的权限，超白名单即拒绝（fail-closed）。
   */
  constructor(
    private readonly container: Container,
    private readonly gate?: PermissionGate,
  ) {}

  /** 注册插件；先过权限门禁，依赖就绪则立即启动（await 等待启动完成）。 */
  async register(plugin: Plugin): Promise<void> {
    if (this.plugins.has(plugin.meta.name)) {
      throw new Error(`插件重复注册: ${plugin.meta.name}`);
    }
    this.gate?.assertAllowed(plugin.meta.name, plugin.meta.permissions);
    this.plugins.set(plugin.meta.name, plugin);
    await this.tryStartAll();
  }

  /** 注册服务并唤醒等待者，随后尝试启动新就绪插件。 */
  async registerService(name: string, service: unknown): Promise<void> {
    this.container.register(name, service);
    for (const handler of this.pending.get(name) ?? []) {
      handler(service);
    }
    this.pending.delete(name);
    await this.tryStartAll();
  }

  /** 卸载插件：逆序执行清理（无副作用残留）。 */
  async uninstall(name: string): Promise<void> {
    const plugin = this.plugins.get(name);
    if (plugin === undefined) {
      return;
    }
    if (this.started.has(name) && plugin.effect !== undefined) {
      await plugin.effect();
    }
    // 精准回收该插件注册的工具（registry 不自动回收，须显式 unregister）。
    const owned = this.pluginTools.get(name);
    if (owned !== undefined) {
      const tools = this.tryGetTools();
      if (tools !== undefined) {
        for (const toolName of owned) {
          tools.unregister?.(toolName);
        }
      }
      this.pluginTools.delete(name);
    }
    this.started.delete(name);
    this.plugins.delete(name);
  }

  /** 取出共享工具端口（未注入则 undefined，不影响无工具插件）。 */
  private tryGetTools(): ToolPort | undefined {
    if (!this.container.has('port.tools')) {
      return undefined;
    }
    return this.container.get<ToolPort>('port.tools');
  }

  /** 是否已启动。 */
  isStarted(name: string): boolean {
    return this.started.has(name);
  }

  /** 已注册插件名。 */
  names(): string[] {
    return [...this.plugins.keys()];
  }

  /** 尝试启动所有依赖已就绪且未启动的插件。 */
  private async tryStartAll(): Promise<void> {
    for (const plugin of this.plugins.values()) {
      if (!this.started.has(plugin.meta.name) && this.dependenciesReady(plugin)) {
        await this.start(plugin);
      }
    }
  }

  /** 依赖服务是否全部就绪。 */
  private dependenciesReady(plugin: Plugin): boolean {
    for (const dependency of plugin.meta.inject ?? []) {
      if (!this.container.has(dependency)) {
        return false;
      }
    }
    return true;
  }

  /** 启动插件（幂等 + 防重入）。 */
  private async start(plugin: Plugin): Promise<void> {
    if (this.started.has(plugin.meta.name) || this.starting.has(plugin.meta.name)) {
      return;
    }
    this.starting.add(plugin.meta.name);
    const tools = this.tryGetTools();
    const hasTools =
      tools !== undefined && typeof (tools as { list?: unknown }).list === 'function';
    const before = hasTools ? (tools as ToolPort).list().map((d) => d.name) : [];
    try {
      await plugin.apply(this.createContext(plugin));
      // 计算本插件 apply 期间新增的工具名（快照增量），供卸载精准回收。
      const after = hasTools ? (tools as ToolPort).list().map((d) => d.name) : [];
      const owned = new Set(after.filter((name) => !before.includes(name)));
      this.pluginTools.set(plugin.meta.name, owned);
      this.started.add(plugin.meta.name);
    } finally {
      this.starting.delete(plugin.meta.name);
    }
  }

  /** 构造插件上下文。 */
  private createContext(_plugin: Plugin): PluginApplyContext {
    return {
      services: this.container,
      onService: (name, handler) => this.onService(name, handler),
      registerService: (name, service) => void this.registerService(name, service),
    };
  }

  /** 订阅服务就绪：已注册立即回调，否则挂起等待。 */
  private onService(name: string, handler: (service: unknown) => void): void {
    if (this.container.has(name)) {
      handler(this.container.get(name));
      return;
    }
    const queue = this.pending.get(name) ?? [];
    this.pending.set(name, [...queue, handler]);
  }
}
