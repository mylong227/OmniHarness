import type { Plugin } from '../../ports/plugin/plugin.ts';
import type { PluginMeta } from '../../ports/plugin/pluginMeta.ts';
import type { PluginPermission } from '../../ports/plugin/pluginPermission.ts';
import type { PluginApplyContext } from '../../ports/plugin/pluginApplyContext.ts';
import type { ToolPort } from '../../ports/tool/tool.ts';
import type { ToolCall } from '../../ports/tool/tool.ts';
import type { ToolContext } from '../../ports/tool/tool/toolContext.ts';
import type { ToolDefinition } from '../../ports/tool/tool/toolDefinition.ts';
import type { ToolResult } from '../../ports/tool/tool/toolResult.ts';
import type { ToolParametersSchema } from '../../ports/tool/tool/toolParametersSchema.ts';
import type { SandboxPort } from '../../ports/runtime/sandbox.ts';
import type { ToolHandler } from '../../adapters/tool/toolHandler.ts';
import { PluginWorkerSupervisor } from './pluginWorkerSupervisor.ts';
import { WorkerCapabilityBroker } from './workerCapabilityBroker.ts';

/** 带注册能力的工具端口（与 `RegistryToolPort` 的结构子集一致）。 */
type RegistrarToolPort = ToolPort & {
  register?: (definition: ToolDefinition, handler: ToolHandler) => void;
  unregister?: (name: string) => boolean;
};

/** Worker 崩溃后的重启退避策略。 */
export interface RemotePluginRestartPolicy {
  /** 最大重启次数（0 关闭）。 */
  readonly maxAttempts?: number;
  /** 首次退避（毫秒），之后指数增长。 */
  readonly baseDelayMs?: number;
  /** 退避上限（毫秒）。 */
  readonly maxDelayMs?: number;
}

/** 远程插件构造选项。 */
export interface RemotePluginOptions {
  /** 插件名（清单 name）。 */
  readonly name: string;
  /** 入口绝对路径。 */
  readonly entryPath: string;
  /** 版本（握手/诊断）。 */
  readonly version?: string;
  /** 清单声明的权限（由 PluginManager 的 PermissionGate 再校验）。 */
  readonly permissions?: readonly string[];
  /** 激活超时（毫秒）。 */
  readonly activationTimeoutMs?: number;
  /** 工具调用超时（毫秒）。 */
  readonly callTimeoutMs?: number;
  /** Worker 入口覆盖（测试用）。 */
  readonly workerEntry?: string;
  /** 能力 broker 的 fs scope（缺省 process.cwd()）。 */
  readonly workspaceRoot?: string;
  /** OS 沙箱（缺省从 `port.sandbox` 取；有 wrapCommand 时启用）。 */
  readonly sandbox?: SandboxPort;
  /** 崩溃重启退避；缺省 3 次（0/`false` 关闭）。 */
  readonly restart?: RemotePluginRestartPolicy | false;
  /** 是否强制 OS 沙箱（缺省 true；`OMNI_PLUGIN_REQUIRE_OS_SANDBOX=0` 可关）。 */
  readonly requireOsSandbox?: boolean;
}

/**
 * 远程插件适配器（ADR-0012）：把 Worker 工具桥接进宿主 `ToolPort`。
 *
 * `apply` 启动 Worker；Worker 注册的每个工具都在父进程生成一个转发 handler。插件代码本身
 * 永远在子进程里运行；`effect` 停止 Worker 并回收父进程侧工具。
 */
export class RemotePlugin implements Plugin {
  /** 插件元信息（名称/权限）。 */
  public readonly meta: PluginMeta;

  /** Worker 监督器（apply 后才有值）。 */
  private supervisor: PluginWorkerSupervisor | undefined;
  /** 父进程工具端口（apply 时取得）。 */
  private toolPort: ToolPort | undefined;
  /** 父进程侧工具名 → Worker 内原始工具名。 */
  private readonly registered = new Map<string, string>();
  /** 已连续重启次数（成功激活后归零）。 */
  private restartAttempts = 0;
  /** 进行中的重启（并发调用共享同一 Promise）。 */
  private restarting: Promise<void> | undefined;
  /** 是否已进入停机（effect 后不再重启）。 */
  private stopping = false;
  /** 重启策略（0 = 关闭）。 */
  private readonly restartPolicy: Required<RemotePluginRestartPolicy>;
  /**
   * @param options 远程插件配置。
   */
  public constructor(private readonly options: RemotePluginOptions) {
    this.meta = {
      name: options.name,
      permissions: options.permissions as readonly PluginPermission[] | undefined,
    };
    const policy = options.restart === false ? {} : (options.restart ?? {});
    this.restartPolicy = {
      maxAttempts: policy.maxAttempts ?? 3,
      baseDelayMs: policy.baseDelayMs ?? 250,
      maxDelayMs: policy.maxDelayMs ?? 4_000,
    };
  }

  /**
   * 启动 Worker 并注册工具。
   * @param context 插件上下文（只取 `port.tools`）。
   * @returns 无返回值；Worker 启动/注册失败时抛错。
   */
  public async apply(context: PluginApplyContext): Promise<void> {
    this.toolPort = context.services.get<ToolPort>('port.tools');
    const sandbox =
      this.options.sandbox ??
      (context.services.has('port.sandbox')
        ? context.services.get<SandboxPort>('port.sandbox')
        : undefined);
    const requireSandbox =
      this.options.requireOsSandbox ?? process.env['OMNI_PLUGIN_REQUIRE_OS_SANDBOX'] !== '0';
    if (requireSandbox && sandbox?.wrapArgv === undefined && sandbox?.wrapCommand === undefined) {
      throw new Error(
        'SANDBOX_UNAVAILABLE: 远程插件必须配置 OS 沙箱（wrapArgv/wrapCommand）；' +
          '请选择 windows-acl / wsl-bwrap 沙箱，或显式设置 OMNI_PLUGIN_REQUIRE_OS_SANDBOX=0。',
      );
    }
    this.stopping = false;
    this.restartAttempts = 0;
    this.supervisor = new PluginWorkerSupervisor({
      pluginName: this.options.name,
      entryPath: this.options.entryPath,
      ...(this.options.version !== undefined ? { pluginVersion: this.options.version } : {}),
      ...(this.options.activationTimeoutMs !== undefined
        ? { activationTimeoutMs: this.options.activationTimeoutMs }
        : {}),
      ...(this.options.callTimeoutMs !== undefined
        ? { callTimeoutMs: this.options.callTimeoutMs }
        : {}),
      ...(this.options.workerEntry !== undefined ? { workerEntry: this.options.workerEntry } : {}),
      broker: new WorkerCapabilityBroker(
        this.options.workspaceRoot ?? process.cwd(),
        (this.options.permissions ?? []) as readonly PluginPermission[],
      ),
      ...(sandbox !== undefined ? { sandbox } : {}),
    });
    try {
      await this.supervisor.start((registration) => this.registerTool(registration));
    } catch (error) {
      await this.supervisor.stop();
      throw error;
    }
  }

  /**
   * 停止 Worker 并回收工具。
   * @returns 无返回值。
   */
  public async effect(): Promise<void> {
    this.stopping = true;
    await this.supervisor?.stop();
    for (const prefixed of this.registered.keys()) {
      this.toolPort?.unregister?.(prefixed);
    }
    this.registered.clear();
  }

  /**
   * 把 Worker 注册转换为父进程工具。
   * @param registration Worker 注册参数。
   * @returns 无返回值。
   */
  private registerTool(registration: {
    readonly definition: {
      readonly name: string;
      readonly description: string;
      readonly parameters: unknown;
      readonly deferred?: boolean;
    };
    readonly handler: string;
  }): void {
    const supervisor = this.supervisor;
    const tools = this.toolPort as RegistrarToolPort;
    if (supervisor === undefined || tools === undefined || typeof tools.register !== 'function') {
      throw new Error('插件 Worker 尚未就绪（工具端口不支持注册）');
    }
    const original = registration.definition.name;
    if (!/^[a-z][a-z0-9_-]*$/u.test(original)) {
      throw new Error(`INVALID_TOOL: 工具名不合法: ${original}`);
    }
    const prefixed = original;
    if (this.registered.has(prefixed)) {
      // Worker 重启后会把同一批工具重新注册；同名替换而不是报错（否则退避重启永远卡在重复注册）。
      tools.unregister?.(prefixed);
      this.registered.delete(prefixed);
    }
    const definition: ToolDefinition = {
      name: prefixed,
      description: registration.definition.description,
      parameters: registration.definition.parameters as ToolParametersSchema,
      ...(registration.definition.deferred === true ? { deferred: true } : {}),
    };
    tools.register(
      definition,
      async (call: ToolCall, context: ToolContext): Promise<ToolResult> => {
        const result = await this.invokeWithRestart(supervisor, original, call, context);
        return { ...result, callId: call.id };
      },
    );
    this.registered.set(prefixed, original);
  }

  /**
   * 调用远程工具；Worker 不可用时按指数退避重启并重试一次。
   * @param supervisor Worker 监督器。
   * @param tool 插件内原始工具名。
   * @param call 工具调用。
   * @param context 工具上下文。
   * @returns 工具结果（重启失败也返回 ok:false，不向宿主抛错）。
   */
  private async invokeWithRestart(
    supervisor: PluginWorkerSupervisor,
    tool: string,
    call: ToolCall,
    context: ToolContext,
  ): Promise<ToolResult> {
    try {
      if (supervisor.state !== 'ready') {
        await this.ensureRestarted();
      }
      let result = await supervisor.invoke(tool, call, context);
      if (!result.ok && supervisor.state !== 'ready') {
        await this.ensureRestarted();
        result = await supervisor.invoke(tool, call, context);
      }
      return result;
    } catch (error) {
      return {
        callId: call.id,
        ok: false,
        error: `WORKER_RESTART_FAILED: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * 单飞重启：并发调用共享同一个重启 Promise。
   * @returns 重启完成。
   */
  private async ensureRestarted(): Promise<void> {
    if (this.stopping) {
      throw new Error('插件正在停机，拒绝重启');
    }
    if (this.restarting !== undefined) {
      return this.restarting;
    }
    this.restarting = this.restart().finally(() => {
      this.restarting = undefined;
    });
    return this.restarting;
  }

  /**
   * 指数退避后重建 Worker；成功激活归零连续失败计数。
   * @returns 重启完成。
   */
  private async restart(): Promise<void> {
    if (this.restartAttempts >= this.restartPolicy.maxAttempts) {
      throw new Error(
        `重启次数已达上限 ${String(this.restartPolicy.maxAttempts)}；插件进入隔离态，等待人工处理`,
      );
    }
    this.restartAttempts += 1;
    const delay = Math.min(
      this.restartPolicy.baseDelayMs * 2 ** (this.restartAttempts - 1),
      this.restartPolicy.maxDelayMs,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
    const supervisor = this.supervisor;
    if (supervisor === undefined) {
      throw new Error('Worker 监督器未初始化');
    }
    await supervisor.stop();
    await supervisor.start((registration) => this.registerTool(registration));
    this.restartAttempts = 0;
  }
}
