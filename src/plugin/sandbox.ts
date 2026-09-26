import { Script, createContext } from 'node:vm';
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
   * 2. **受限全局**：上下文默认只持有 V8 自带的、与宿主隔离的内建（Object/Array/Promise…），
   *    不注入 `require`/`process`/`global`/`fetch`/`import`，因此插件无法触达宿主 Node 能力。
   *    （注：这是 best-effort 隔离，非对抗国家级攻击者的安全边界。）
   * 3. **能力仍由 PermissionGate 把关**：沙箱只管「代码隔离」，插件声明的能力（port.tools 等）
   *    仍由 PluginManager 的权限门禁校验，越白名单即拒绝注册。
   * 4. **超时熔断（口径已澄清，2026-09-26 审计 S16）**：
   *    旧实现只在 `apply` 外面套了 `Promise.race(setTimeout)`，而**同步死循环会让事件循环停摆**，
   *    那个 `setTimeout` 根本没机会跑 —— 「广告里的超时」对真实威胁（插件里一句 `while(true){}`）
   *    完全不可达。现在两条路径都用 **V8 的 vm timeout**（能真正打断同步执行）：
   *      · **编译 + 工厂调用**：整段包在一个带 `timeout` 的 Script 里执行 ⇒ 模块顶层死循环被中止；
   *      · **apply**：经同一个上下文里的 Script 调用 ⇒ 同步段同样受 `timeout` 约束；
   *        其后的**异步**悬挂再由 `Promise.race` 兜住总时长。
   *    **诚实边界**：越过首个 `await` 之后的同步死循环仍无法就地中止（V8 的终止只覆盖
   *    `runInContext` 期间）。彻底不可信的代码必须放到独立进程 / Worker + OS 级沙箱。
   *
   * @param code 插件入口文件源码（须 `export default { meta, apply }`）
   * @param filename 用于错误定位的文件名
   * @param applyTimeoutMs apply 超时（默认 10s）；同时用作编译/工厂/apply 同步段的 vm timeout
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

    const sandbox: Record<string, unknown> = {
      console: Sandbox.limitedConsole(),
      __plugin: undefined,
      __ctx: undefined,
    };
    const context = createContext(sandbox);
    let plugin: Plugin;
    try {
      // 编译 + 工厂调用**整段**放进带 timeout 的 Script：模块顶层写 `while(true){}` 也会被中止
      // （旧实现直接在宿主线程调 factory()，那一步没有任何超时保护）。
      plugin = new Script(`(function(){ ${transformed} })()`, { filename }).runInContext(context, {
        timeout: applyTimeoutMs,
      }) as Plugin;
    } catch (error) {
      throw new Error(Sandbox.describeLoadFailure(error, applyTimeoutMs));
    }

    if (
      plugin === undefined ||
      plugin === null ||
      typeof plugin.apply !== 'function' ||
      typeof plugin.meta?.name !== 'string'
    ) {
      throw new Error('沙箱插件默认导出无效（需为 { meta, apply }）');
    }

    // 包装 apply：同步段由 vm timeout 约束，异步悬挂由 Promise.race 兜住总时长。
    const meta = plugin.meta;
    sandbox['__plugin'] = plugin;
    const invokeApply = new Script('__plugin.apply(__ctx)');
    const wrapped: Plugin = {
      meta,
      effect: plugin.effect?.bind(plugin),
      async apply(context_: PluginApplyContext): Promise<void> {
        sandbox['__ctx'] = context_;
        let pending: unknown;
        try {
          pending = invokeApply.runInContext(context, { timeout: applyTimeoutMs });
        } catch (error) {
          throw new Error(Sandbox.describeApplyFailure(error, applyTimeoutMs));
        }
        await Promise.race([
          Promise.resolve(pending).then(() => undefined),
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

  /**
   * 把编译/工厂阶段的失败归一为可读错误（超时要与语法错误区分开）。
   * @param error 捕获到的错误。
   * @param timeoutMs 本阶段生效的 vm timeout。
   * @returns 面向调用方的错误文案。
   */
  private static describeLoadFailure(error: unknown, timeoutMs: number): string {
    const message = error instanceof Error ? error.message : String(error);
    return /timed out/i.test(message)
      ? `沙箱插件编译/初始化超时（>${String(timeoutMs)}ms，疑为顶层死循环）`
      : `沙箱插件编译失败: ${message}`;
  }

  /**
   * 把 apply 同步阶段的失败归一为可读错误。
   * @param error 捕获到的错误。
   * @param timeoutMs 本阶段生效的 vm timeout。
   * @returns 面向调用方的错误文案。
   */
  private static describeApplyFailure(error: unknown, timeoutMs: number): string {
    const message = error instanceof Error ? error.message : String(error);
    return /timed out/i.test(message)
      ? `沙箱插件 apply 超时（>${String(timeoutMs)}ms）`
      : `沙箱插件 apply 失败: ${message}`;
  }
}

/**
 * @beta
 * 沙箱 apply 超时（毫秒）；超过即熔断，避免恶意/失控插件挂死服务器。
 */
export const DEFAULT_APPLY_TIMEOUT_MS = 10_000;
