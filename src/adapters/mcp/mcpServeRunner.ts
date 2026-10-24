/**
 * MCP serve 装配器（McpServeRunner）——让 `omniharness mcp serve` 在**不假装支持**的前提下
 * 选择实际能服务 2026-07-28 的实现。
 *
 * 事故口径（2026-09-19 入口可达性审计）：`src/adapters/mcp/sdkMcpServerAdapter.ts` 写了、有单测，
 * 却没有任何生产接线点——`mcp serve` 一直只用手写 `src/mcp/*`，官方 SDK 的协议协商能力从未上线。
 *
 * 2026-07-28 的选择纪律（**绝不静默**）：
 *   1. 官方 SDK 1.32 只支持到 `2025-11-25`，**原生不支持** 2026-07-28；
 *   2. `auto`（默认）：SDK 支持 2026-07-28 才走 SDK，否则走**内置 custom-v2**（手写双栈实现），
 *      并把「SDK 实际版本 + 回落原因」打到 stderr；
 *   3. 显式 `OMNI_MCP_SERVE_PROTOCOL=sdk`：允许走 SDK，但横幅/结果**如实声明** SDK 实际协议版本
 *      （降级为 2025-11-25 语义，不声称 2026-07-28）；
 *   4. 显式 `v2`：强制内置实现（即使 SDK 将来支持）；
 *   5. SDK 不可用/起不来：回落内置实现，并打印原因（fail-soft，但不静默）。
 *
 * 门禁不因换实现而丢失：SDK 路径的工具端口先经 {@link GatedToolPort} 包装，审批 + 沙箱语义与手写一致。
 */
import { createInterface } from 'node:readline';
import { McpServer, type McpServerOptions } from '../../mcp/mcpServer.ts';
import { McpProtocol } from '../../mcp/mcpProtocol.ts';
import { LineTransport } from '../../server/transport/lineTransport.ts';
import type { ToolContext, ToolPort } from '../../ports/tool/tool.ts';
import type { McpInputRequiredPort } from '../../ports/mcp/mcpInputRequiredPort.ts';
import { GatedToolPort, type ToolGateLike } from './gatedToolPort.ts';
import { McpSdkProbe, type McpSdkProbeResult } from './mcpSdkProbe.ts';
import { SdkMcpServerAdapter, type SdkServerInfo } from './sdkMcpServerAdapter.ts';

/** 手写回退服务器的门禁类型（与手写 `McpServerOptions.gate` 同源，避免适配器反向依赖 core）。 */
type FallbackGate = McpServerOptions['gate'];

/** 协议栈选择。 */
export type McpServeProtocolChoice = 'auto' | 'sdk' | 'v2';

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
  /** 协议栈偏好（缺省 auto；也可经 `OMNI_MCP_SERVE_PROTOCOL` 覆盖）。 */
  readonly protocol?: McpServeProtocolChoice | undefined;
  /** MRTR live handler（仅内置实现消费；SDK 不支持 2026-07-28 MRTR）。 */
  readonly inputRequired?: McpInputRequiredPort | undefined;
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

/** serve 启动结果（选择模式、实际协议版本与原因，供 CLI 与单测断言）。 */
export interface McpServeResult {
  /** 实际生效的实现：`sdk`（官方适配器）、`custom-v2`（内置双栈）或 `fallback`（SDK 不可用）。 */
  readonly mode: 'sdk' | 'custom-v2' | 'fallback';
  /** 判断依据（版本号或回落原因，人类可读）。 */
  readonly detail: string;
  /** **实际宣称**服务的协议版本列表（不夸大）。 */
  readonly protocolVersions: readonly string[];
}

/**
 * MCP serve 装配器：探测 → 选择实现 → 起服务（常驻）。
 */
export class McpServeRunner {
  /** 缺省元数据（未提供时与手写实现的历史缺省一致）。 */
  private static readonly DEFAULT_INFO: SdkServerInfo = { name: 'omniharness', version: '0.1.0' };
  /** 内置实现实际支持的协议版本（现代 + legacy 双栈）。 */
  private static readonly CUSTOM_V2_VERSIONS: readonly string[] = [
    ...McpProtocol.SUPPORTED_VERSIONS,
  ];
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
   * 启动 MCP 服务（stdio）：按协议能力选择 SDK / 内置 custom-v2，永不静默降级。
   * @param options serve 选项（工具集 / 上下文 / 门禁 / 元数据 / 协议偏好 / MRTR handler）
   * @param onSelect 模式选择回调（如实上报实现与**实际协议版本**）
   * @returns 永不 resolve 的 Promise（常驻服务）
   */
  public async run(
    options: McpServeOptions,
    onSelect: (result: McpServeResult) => void,
  ): Promise<number> {
    const choice = McpServeRunner.choiceOf(options.protocol);
    const probe = await (this.deps.probe ?? McpSdkProbe.check)();
    if (!probe.available) {
      onSelect({
        mode: 'fallback',
        detail: probe.reason ?? '未知原因',
        protocolVersions: McpServeRunner.CUSTOM_V2_VERSIONS,
      });
      this.write(
        `[omniharness] MCP SDK 不可用（${probe.reason ?? '未知原因'}），` +
          `回落内置实现（协议 ${McpServeRunner.versionList()}）\n`,
      );
      return this.runFallback(options);
    }
    if (choice === 'v2' || (choice === 'auto' && !McpServeRunner.supportsModern(probe))) {
      return this.runCustomV2(options, probe, onSelect);
    }
    try {
      await this.serveSdk(options);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      onSelect({
        mode: 'fallback',
        detail: `SDK 启动失败: ${reason}`,
        protocolVersions: McpServeRunner.CUSTOM_V2_VERSIONS,
      });
      this.write(
        `[omniharness] MCP SDK 启动失败（${reason}），回落内置实现` +
          `（协议 ${McpServeRunner.versionList()}）\n`,
      );
      return this.runFallback(options);
    }
    const actual = McpServeRunner.actualSdkVersions(probe);
    onSelect({
      mode: 'sdk',
      detail: `官方 SDK ${probe.version ?? '未知版本'}（实际协议 ${actual.join(', ')}）`,
      protocolVersions: actual,
    });
    this.write(
      `[omniharness] MCP 服务器使用官方 SDK 适配器（${probe.version ?? '未知版本'}），` +
        `实际协议版本：${actual.join(', ')}；stdio 传输\n`,
    );
    return new Promise(() => undefined);
  }

  /**
   * 内置 custom-v2 路径：手写双栈服务器（2026-07-28 + legacy），并打印回落到它的**原因**。
   * @param options serve 选项
   * @param probe SDK 探测结果（用于说明 SDK 实际版本）
   * @param onSelect 模式上报
   * @returns 永不 resolve 的 Promise（常驻服务）
   */
  private runCustomV2(
    options: McpServeOptions,
    probe: McpSdkProbeResult,
    onSelect: (result: McpServeResult) => void,
  ): Promise<number> {
    const sdkVersion = probe.protocolVersion ?? probe.version ?? '未知版本';
    const detail =
      `官方 SDK ${probe.version ?? '未知版本'} 实际协议 ${sdkVersion}，原生不含 2026-07-28；` +
      `改用内置 2026-07-28 双栈实现`;
    onSelect({
      mode: 'custom-v2',
      detail,
      protocolVersions: McpServeRunner.CUSTOM_V2_VERSIONS,
    });
    this.write(
      `[omniharness] ${detail}（实际协议 ${McpServeRunner.versionList()}）；` +
        '未声称 SDK 提供 2026-07-28\n',
    );
    return this.runFallback(options);
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
   * 内置/回退路径：手写 MCP 服务器（stdio 行式传输）。
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
      ...(options.inputRequired !== undefined ? { inputRequired: options.inputRequired } : {}),
    });
    return new Promise(() => undefined);
  }

  /**
   * 协议偏好：选项优先，其次 `OMNI_MCP_SERVE_PROTOCOL`，缺省 auto。
   * @param explicit 选项值。
   * @returns 协议选择。
   */
  private static choiceOf(explicit: McpServeProtocolChoice | undefined): McpServeProtocolChoice {
    if (explicit !== undefined) return explicit;
    const raw = process.env['OMNI_MCP_SERVE_PROTOCOL']?.trim().toLowerCase();
    return raw === 'sdk' || raw === 'v2' ? raw : 'auto';
  }

  /**
   * SDK 是否原生支持 2026-07-28。
   * @param probe 探测结果。
   * @returns 支持为 true。
   */
  private static supportsModern(probe: McpSdkProbeResult): boolean {
    return (
      probe.supports20260728 === true ||
      probe.protocolVersion === McpProtocol.PROTOCOL_VERSION_V2 ||
      probe.supportedProtocolVersions?.includes(McpProtocol.PROTOCOL_VERSION_V2) === true
    );
  }

  /**
   * SDK 实际对外版本列表（优先 supported 列表，其次 current，最后「未知」）。
   * @param probe 探测结果。
   * @returns 版本列表。
   */
  private static actualSdkVersions(probe: McpSdkProbeResult): readonly string[] {
    if (
      probe.supportedProtocolVersions !== undefined &&
      probe.supportedProtocolVersions.length > 0
    ) {
      return [...probe.supportedProtocolVersions];
    }
    return [probe.protocolVersion ?? 'unknown'];
  }

  /**
   * 版本列表文案。
   * @returns 逗号分隔版本。
   */
  private static versionList(): string {
    return McpServeRunner.CUSTOM_V2_VERSIONS.join(', ');
  }
}
