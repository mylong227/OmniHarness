/**
 * MCP serve 装配器（McpServeRunner）——让 `omniharness mcp serve` 默认走**官方 SDK 适配器**。
 *
 * 事故口径（2026-09-19 入口可达性审计）：`src/adapters/mcp/sdkMcpServerAdapter.ts` 写了、有单测，
 * 却没有任何生产接线点——`mcp serve` 一直只用手写 `src/mcp/*`，官方 SDK 的协议协商能力从未上线。
 *
 * 本装配器的选择纪律（**绝不静默降级**）：
 *   1. 默认探测官方 SDK；可用即用 `SdkMcpServerAdapter` + `StdioServerTransport`，并把探测到的版本
 *      打到 stderr（可核对上线的是哪一版协议实现）；
 *   2. SDK 不可用 → 回落既有手写 `McpServer`，并**如实打印回落原因**；
 *   3. SDK 可用但装载/连接失败 → 同样回落，并把失败原因打出来（fail-soft，但不静默）。
 *
 * 门禁不因换实现而丢失：SDK 路径的工具端口先经 {@link GatedToolPort} 包装，审批 + 沙箱语义与手写一致。
 */
import { createInterface } from 'node:readline';
import { McpServer, type McpServerOptions } from '../../mcp/mcpServer.js';
import { LineTransport } from '../../server/transport/lineTransport.js';
import type { ToolContext, ToolPort } from '../../ports/tool/tool.js';
import { GatedToolPort, type ToolGateLike } from './gatedToolPort.js';
import { McpSdkProbe, type McpSdkProbeResult } from './mcpSdkProbe.js';
import { SdkMcpServerAdapter, type SdkServerInfo } from './sdkMcpServerAdapter.js';

/** 手写回退服务器的门禁类型（与手写 `McpServerOptions.gate` 同源，避免适配器反向依赖 core）。 */
type FallbackGate = McpServerOptions['gate'];

/** SDK 服务端工厂（测试注入假实现以验证「走 SDK / 回落」两条路径）。 */
export type SdkMcpServerFactory = (
  tools: ToolPort,
  info: SdkServerInfo,
  sessionId?: string,
) => Promise<void>;

/** serve 选项（工具集 + 门禁 + 元数据）。 */
export interface McpServeOptions {
  /** 工具端口（harness 工具集）；SDK 路径会在其上包一层门禁。 */
  readonly tools: ToolPort;
  /**
   * 手写回退路径使用的工具端口（缺省同 `tools`）。
   *
   * 之所以可分开：手写 `McpServer` 自己就吃 `ToolGate`（它位于 src/mcp，可直接依赖 core），
   * 而适配器层不许 adapters→core——于是 SDK 路径用 {@link GatedToolPort} 包装，
   * 回退路径把原始工具端口 + 门禁一起交给手写实现。两条路径的门禁语义因此都不丢。
   */
  readonly fallbackTools?: ToolPort | undefined;
  /** 手写回退路径使用的门禁（类型取自手写 `McpServer` 的选项，宿主传入真实 `ToolGate`）。 */
  readonly fallbackGate?: FallbackGate;
  /** 工具执行上下文（会话 id 与工作区根）。 */
  readonly context: ToolContext;
  /** 审批 + 沙箱门禁（SDK 路径据此包装工具端口；回退路径由手写实现消费）。 */
  readonly gate?: ToolGateLike | undefined;
  /** 对外上报的服务器元数据。 */
  readonly serverInfo?: SdkServerInfo | undefined;
}

/** serve 依赖（可注入以便单测）。 */
export interface McpServeDeps {
  /** SDK 可用性探测（缺省 {@link McpSdkProbe.check}）。 */
  readonly probe?: (() => Promise<McpSdkProbeResult>) | undefined;
  /** SDK 服务端启动器（缺省用 {@link SdkMcpServerAdapter} + StdioServerTransport）。 */
  readonly createSdkServer?: SdkMcpServerFactory | undefined;
  /** 手写回退服务器构造器（缺省真实 {@link McpServer}，走 stdio）。 */
  readonly createFallbackServer?: ((options: McpServeOptions) => void) | undefined;
  /** 提示输出通道（缺省 stderr，避开 stdout 的 MCP 协议通道）。 */
  readonly write?: ((text: string) => void) | undefined;
}

/** serve 启动结果（选择模式与原因，供 CLI 与单测断言）。 */
export interface McpServeResult {
  /** 实际生效的实现：`sdk`（官方适配器）或 `fallback`（手写）。 */
  readonly mode: 'sdk' | 'fallback';
  /** 判断依据（版本号或回落原因，人类可读）。 */
  readonly detail: string;
}

/**
 * MCP serve 装配器：探测 → 选择实现 → 起服务（常驻）。
 */
export class McpServeRunner {
  /** 缺省元数据（未提供时与手写实现的历史缺省一致）。 */
  private static readonly DEFAULT_INFO: SdkServerInfo = { name: 'omniharness', version: '0.1.0' };
  /** 依赖（探测 / 两套启动器 / 输出）。 */
  private readonly deps: McpServeDeps;
  /** 提示输出通道。 */
  private readonly write: (text: string) => void;

  /**
   * @param deps 探测与启动器（均可缺省，缺省走真实 SDK / stdio）
   */
  public constructor(deps: McpServeDeps = {}) {
    this.deps = deps;
    this.write = deps.write ?? ((text) => process.stderr.write(text));
  }

  /**
   * 启动 MCP 服务（stdio）：优先官方 SDK，不可用或起不来则回落手写实现。
   * @param options serve 选项（工具集 / 上下文 / 门禁 / 元数据）
   * @returns 永不 resolve 的 Promise（常驻服务）；模式选择经 `onSelect` 回调如实上报
   */
  public async run(
    options: McpServeOptions,
    onSelect: (result: McpServeResult) => void,
  ): Promise<number> {
    const probe = await (this.deps.probe ?? McpSdkProbe.check)();
    if (!probe.available) {
      onSelect({ mode: 'fallback', detail: probe.reason ?? '未知原因' });
      this.write(`[omniharness] MCP SDK 不可用（${probe.reason ?? '未知原因'}），回落手写实现\n`);
      return this.runFallback(options);
    }
    try {
      await this.serveSdk(options);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      onSelect({ mode: 'fallback', detail: `SDK 启动失败: ${reason}` });
      this.write(`[omniharness] MCP SDK 启动失败（${reason}），回落手写实现\n`);
      return this.runFallback(options);
    }
    onSelect({
      mode: 'sdk',
      detail: probe.version === undefined ? '官方 SDK' : `官方 SDK ${probe.version}`,
    });
    this.write(
      `[omniharness] MCP 服务器使用官方 SDK 适配器（${probe.version ?? '未知版本'}），stdio 传输\n`,
    );
    return new Promise(() => undefined);
  }

  /**
   * SDK 路径：门禁包装后的工具端口 → 官方 SDK McpServer（stdio）。
   * @param options serve 选项
   * @returns 连接就绪后 resolve（常驻由调用方的永不 resolve Promise 保证）
   */
  private async serveSdk(options: McpServeOptions): Promise<void> {
    const tools: ToolPort =
      options.gate === undefined ? options.tools : new GatedToolPort(options.tools, options.gate);
    const info = options.serverInfo ?? McpServeRunner.DEFAULT_INFO;
    const starter = this.deps.createSdkServer;
    if (starter !== undefined) {
      await starter(tools, info, options.context.sessionId);
      return;
    }
    const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
    await new SdkMcpServerAdapter(tools, info, () => options.context.sessionId).connectTransport(
      new StdioServerTransport(),
    );
  }

  /**
   * 回退路径：既有手写 MCP 服务器（stdio 行式传输），行为与接线前一致。
   * @param options serve 选项
   * @returns 永不 resolve 的 Promise（常驻服务）
   */
  private runFallback(options: McpServeOptions): Promise<number> {
    const factory = this.deps.createFallbackServer;
    if (factory !== undefined) {
      factory(options);
      return new Promise(() => undefined);
    }
    const transport = new LineTransport(
      (onLine) => {
        const readline = createInterface({ input: process.stdin, crlfDelay: Infinity });
        readline.on('line', onLine);
      },
      (line) => process.stdout.write(`${line}\n`),
    );
    new McpServer({
      transport,
      tools: options.fallbackTools ?? options.tools,
      context: options.context,
      gate: options.fallbackGate,
      serverInfo: options.serverInfo ?? McpServeRunner.DEFAULT_INFO,
    });
    return new Promise(() => undefined);
  }
}
