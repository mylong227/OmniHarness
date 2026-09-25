import { runInNewContext } from 'node:vm';
import type { Plugin, PluginApplyContext } from './plugin.js';

/**
 * Sandbox 相关纯函数工具（C7 收口：原顶层内部函数迁入）。
 */
export class Sandbox {
  /**
   * 仅暴露空操作的控制台，避免插件刷屏或借 console 逃逸。
  
   * @returns Record<string, unknown>
   */
  public static limitedConsole(): Record<string, unknown> {
    const noop = (): void => undefined;
    return { log: noop, info: noop, warn: noop, error: noop, debug: noop, trace: noop };
  }

  /**
   * @beta
   * 在受限 VM 上下文里加载「远程/不可信」插件代码，返回一个经隔离与超时熔断包装的插件对象。
   *
   * 安全模型（保守、fail-closed）：
   * 1. **自包含**：禁止 `import` / `require` / `module.` —— 远程插件不得拉取外部模块，必须自带逻辑。
   * 2. **受限全局**：上下文默认只持有 V8 自带的、与宿主隔离的内建（Object/Array/JSON/Promise…），
   *    不注入 `require`/`process`/`global`/`fetch`/`import`，因此插件无法触达宿主 Node 能力。
   *    （注：这是 best-effort 隔离，非对抗国家级攻击者的安全边界；彻底不可信代码应放到独立进程/Worker + OS 级沙箱。）
   * 3. **能力仍由 PermissionGate 把关**：沙箱只管「代码隔离」，插件声明的能力（port.tools 等）
   *    仍由 PluginManager 的权限门禁校验，越白名单即拒绝注册。
   * 4. **apply 超时熔断**：包装 apply，超过 {@link DEFAULT_APPLY_TIMEOUT_MS} 直接 reject，防挂死。
   *
   * @param code 插件入口文件源码（须 `export default { meta, apply }`）
   * @param filename 用于错误定位的文件名
   * @param applyTimeoutMs apply 超时（默认 10s）
   * @returns 可交给 PluginManager.register 的插件对象
   */
  public static loadPluginCodeInSandbox(
    code: string,
    filename: string,
    applyTimeoutMs: number = DEFAULT_APPLY_TIMEOUT_MS,
  ): Plugin {
    if (/\bimport\s/.test(code) || /\brequire\s*\(/.test(code) || /\bmodule\s*\./.test(code)) {
      throw new Error('沙箱插件禁止 import/require/module（必须自包含）');
    }
    const transformed = code.replace(/export\s+default\s+/, 'return ');
    if (!transformed.includes('return ')) {
      throw new Error('沙箱插件须用 `export default` 导出插件对象');
    }

    const sandbox = { console: Sandbox.limitedConsole() };
    let factory: () => unknown;
    try {
      factory = runInNewContext(`(function(){ ${transformed} })`, sandbox, {
        filename,
      }) as () => unknown;
    } catch (error) {
      throw new Error(
        `沙箱插件编译失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const plugin = factory() as Plugin | undefined;
    if (
      plugin === undefined ||
      plugin === null ||
      typeof plugin.apply !== 'function' ||
      typeof plugin.meta?.name !== 'string'
    ) {
      throw new Error('沙箱插件默认导出无效（需为 { meta, apply }）');
    }

    // 包装 apply：加超时熔断，防失控插件挂死服务器。
    const meta = plugin.meta;
    const innerApply = plugin.apply.bind(plugin);
    const wrapped: Plugin = {
      meta,
      effect: plugin.effect?.bind(plugin),
      apply(context: PluginApplyContext): Promise<void> {
        return Promise.race([
          Promise.resolve(innerApply(context)),
          new Promise<void>((_, reject) => {
            setTimeout(
              () => reject(new Error(`沙箱插件 apply 超时（>${applyTimeoutMs}ms）`)),
              applyTimeoutMs,
            );
          }),
        ]);
      },
    };
    return wrapped;
  }
}

/**
 * @beta
 * 沙箱 apply 超时（毫秒）；超过即熔断，避免恶意/失控插件挂死服务器。
 */
export const DEFAULT_APPLY_TIMEOUT_MS = 10_000;
