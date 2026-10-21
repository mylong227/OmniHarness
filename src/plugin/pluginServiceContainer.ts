import type { ContainerPort } from '../ports/runtime/containerPort.ts';
import type { ServiceKeyLike } from '../ports/runtime/serviceKeyLike.ts';
import type { ToolDefinition, ToolPort } from '../ports/tool/tool.ts';
import type { ToolHandler } from '../adapters/tool/toolHandler.ts';

/** 带注册能力的工具端口（`RegistryToolPort` 的结构子集）。 */
type RegistrarToolPort = ToolPort & {
  register?: (definition: ToolDefinition, handler: ToolHandler) => void;
  unregister?: (name: string) => boolean;
  listDirect?: () => readonly ToolDefinition[];
  markDeferred?: (names: readonly string[]) => void;
};

/**
 * 插件专用服务容器（2026-10-21）。
 *
 * 为什么需要：插件 apply 里拿到的是完整宿主容器，`services.get('port.tools').execute(...)`
 * 会**直接执行**工具，绕过 ToolGate 的审批/沙箱/监督内核——一个声明了无害权限的插件即可
 * 借道执行 `shell`/`write_file`。这里把工具端口降级为「只能注册/列举」的视图：
 * 插件仍能注册自己的工具（正常用法），但不能替 Agent 执行工具。
 */
export class PluginServiceContainer implements ContainerPort {
  /** 注册-只读工具视图（懒建；底层端口可能尚未注册）。 */
  private toolView: ToolPort | undefined;

  /**
   * @param inner 真实容器。
   */
  public constructor(private readonly inner: ContainerPort) {}

  /**
   * 注册服务（委托真实容器）。
   * @param key 服务令牌或字符串键。
   * @param instance 服务实例。
   * @returns 无返回值。
   */
  public register(key: ServiceKeyLike<unknown> | string, instance: unknown): void {
    if (typeof key === 'string') {
      this.inner.register(key, instance);
    } else {
      this.inner.register(key, instance);
    }
  }

  /**
   * 覆盖服务（委托真实容器）。
   * @param key 服务令牌或字符串键。
   * @param instance 服务实例。
   * @returns 无返回值。
   */
  public overwrite(key: ServiceKeyLike<unknown> | string, instance: unknown): void {
    if (typeof key === 'string') {
      this.inner.overwrite(key, instance);
    } else {
      this.inner.overwrite(key, instance);
    }
  }

  /**
   * 服务是否存在。
   * @param key 服务令牌或字符串键。
   * @returns 已注册时为 true。
   */
  public has(key: ServiceKeyLike<unknown> | string): boolean {
    return this.inner.has(key);
  }

  /**
   * 取服务；`port.tools` 返回注册-只读视图，其余原样。
   * @param key 服务令牌或字符串键。
   * @returns 服务实例（工具端口已被降级）。
   */
  public get<T>(key: ServiceKeyLike<T> | string): T {
    const name = typeof key === 'string' ? key : key.name;
    if (name !== 'port.tools') {
      return typeof key === 'string'
        ? this.inner.get<T>(key)
        : this.inner.get<T>(key as ServiceKeyLike<T>);
    }
    this.toolView ??= PluginServiceContainer.registerOnlyView(this.inner.get<ToolPort>(name));
    return this.toolView as T;
  }

  /**
   * 构造注册-只读工具视图。
   * @param tools 真实工具端口。
   * @returns 只暴露 list/register/unregister/listDirect 的视图；execute 恒拒绝。
   */
  private static registerOnlyView(tools: ToolPort): ToolPort {
    const registrar = tools as RegistrarToolPort;
    return {
      name: tools.name,
      list: () => tools.list(),
      execute: () =>
        Promise.reject(
          new Error('插件不得直接执行工具（会绕过审批/沙箱）；请注册工具由 Agent 调用'),
        ),
      ...(registrar.unregister !== undefined
        ? { unregister: (name: string) => registrar.unregister?.(name) ?? false }
        : {}),
      ...(registrar.listDirect !== undefined
        ? { listDirect: () => registrar.listDirect?.() ?? tools.list() }
        : {}),
      ...(registrar.register !== undefined
        ? {
            register: (definition: ToolDefinition, handler: ToolHandler) =>
              registrar.register?.(definition, handler),
          }
        : {}),
      ...(registrar.markDeferred !== undefined
        ? { markDeferred: (names: readonly string[]) => registrar.markDeferred?.(names) }
        : {}),
    } as unknown as ToolPort;
  }
}
