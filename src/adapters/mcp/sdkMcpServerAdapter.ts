/**
 * MCP 官方 SDK 服务端适配器（A1 · 协议兼容性差距闭合）。
 *
 * 背景：`src/mcp/*` 的手写实现停留在 2025-06-18 握手式协议；主流 MCP 客户端生态已由
 * 官方 SDK 托管协议协商（2025-11-25 最新 + 五版本向后兼容）、Streamable HTTP 传输与
 * OAuth 2.1 资源服务器语义——自研追平的边际成本远高于引入官方实现（D10 择优依赖）。
 *
 * 本适配器把 harness 的 `ToolPort` 工具集桥接为官方 SDK 的 `McpServer`：
 * - 工具发现：`ToolPort.list()` → SDK `registerTool`（inputSchema 用 JSON Schema 原样透传）；
 * - 工具执行：SDK 回调 → `ToolPort.execute()`，结果映射为 MCP content（text）；
 * - 传输：内存（InMemoryTransport，测试/嵌入用）与 Streamable HTTP（部署用）由调用方选择。
 *
 * 分层纪律：`@modelcontextprotocol/sdk` 只出现在 `src/adapters/mcp/**`（D10 准入，
 * 见 dependency-allowlist.json）；既有手写 `src/mcp/*` 保留为旧版并行兼容路径。
 *
 * @maturity L1 — 协议协商与工具往返由官方 SDK 双端实测；Streamable HTTP 部署形态待跨机验证
 * @maturityEvidence tests/unit/mcpSdkAdapter.test.ts, tests/unit/mcpServeWiring.test.ts
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import type {
  ToolPort,
  ToolDefinition,
  ToolCall,
  ToolResult,
  ToolContext,
} from '../../ports/tool/tool.js';

/** SDK 服务端元数据（握手时上报）。 */
export interface SdkServerInfo {
  /** 服务器名称（如 `omniharness`）。 */
  readonly name: string;
  /** 服务器版本。 */
  readonly version: string;
}

/** 内存往返连接句柄：client 端 + 双端断开器。 */
export interface InMemoryPair {
  /** 官方 SDK 客户端（已连接，可直接 listTools/callTool）。 */
  readonly client: Client;
  /** 断开双端连接。 */
  readonly close: () => Promise<void>;
}

/**
 * 官方 SDK 服务端适配器：把 ToolPort 工具集暴露为标准 MCP 服务器。
 * 每次 `createMcpServer()` 生成一个独立的 SDK server 实例（工具清单在创建时快照注册）。
 */
export class SdkMcpServerAdapter {
  /** 工具端口：工具清单与执行后端。 */
  private readonly tools: ToolPort;
  /** 服务器元数据（握手上报）。 */
  private readonly info: SdkServerInfo;
  /** 会话 id 供给器（MCP 会话与 harness 会话的桥）。 */
  private readonly sessionId: () => string;

  /**
   * @param tools 工具端口（工具清单与执行后端）
   * @param info 服务器元数据
   * @param sessionId 工具执行上下文的会话 id 供给器（MCP 会话与 harness 会话的桥）
   */
  public constructor(
    tools: ToolPort,
    info: SdkServerInfo,
    sessionId: () => string = () => 'mcp-sdk',
  ) {
    this.tools = tools;
    this.info = info;
    this.sessionId = sessionId;
  }

  /**
   * 构建一个已注册全部 harness 工具的官方 SDK server。
   * @returns SDK McpServer 实例（尚未连接任何传输）
   */
  public createMcpServer(): McpServer {
    const server = new McpServer({ name: this.info.name, version: this.info.version });
    for (const def of this.tools.list()) {
      server.registerTool(
        def.name,
        {
          description: def.description,
          inputSchema: this.toZodShape(def),
        },
        async (args: Record<string, unknown>) => this.invoke(def.name, args),
      );
    }
    return server;
  }

  /**
   * 建立内存往返连接（测试/嵌入形态）：SDK server 与 SDK client 经 InMemoryTransport 直连。
   * @returns 已连接的客户端与断开器
   */
  public async connectInMemory(): Promise<InMemoryPair> {
    const server = this.createMcpServer();
    const client = new Client({ name: `${this.info.name}-client`, version: this.info.version });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return {
      client,
      close: async () => {
        await client.close();
        await server.close();
      },
    };
  }

  /**
   * 连到调用方提供的官方 SDK 传输（生产形态：`mcp serve` 注入 StdioServerTransport）。
   * 与 {@link connectInMemory} 同源，只是传输由外部选择——避免宿主机为了接传输而重写注册逻辑。
   * @param transport 官方 SDK 传输（Transport 契约；由调用方构造与持有）
   * @returns 连接就绪后 resolve（协议协商由官方 SDK 接管），无载荷
   */
  public async connectTransport(transport: Transport): Promise<void> {
    await this.createMcpServer().connect(transport);
  }

  /**
   * 经 ToolPort 执行一次工具调用并把结果映射为 MCP content。
   * @param name 工具名
   * @param args 工具参数（SDK 已按 inputSchema 校验）
   * @returns MCP 工具结果（content text + isError 标志）
   */
  private async invoke(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }> {
    const call: ToolCall = {
      id: `mcp-sdk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      arguments: args,
    };
    const context: ToolContext = { sessionId: this.sessionId(), workspaceRoot: process.cwd() };
    const result: ToolResult = await this.tools.execute(call, context);
    const text = result.ok ? (result.output ?? '') : (result.error ?? '未知错误');
    return {
      content: [{ type: 'text', text }],
      isError: !result.ok,
    };
  }

  /**
   * ToolParametersSchema（JSON Schema 形状）→ Zod RawShape（SDK registerTool 的 inputSchema 形状）。
   * 仅映射 harness 实际使用的标量/数组/对象类型；未识别类型回退为 z.unknown()（fail-soft）。
   * @param def 工具定义
   * @returns Zod RawShape 对象
   */
  private toZodShape(def: ToolDefinition): Record<string, z.ZodTypeAny> {
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [key, raw] of Object.entries(def.parameters.properties)) {
      const spec = (raw ?? {}) as { type?: string; description?: string; items?: unknown };
      let t: z.ZodTypeAny;
      switch (spec.type) {
        case 'string':
          t = z.string();
          break;
        case 'number':
        case 'integer':
          t = z.number();
          break;
        case 'boolean':
          t = z.boolean();
          break;
        case 'array':
          t = z.array(z.unknown());
          break;
        case 'object':
          t = z.record(z.string(), z.unknown());
          break;
        default:
          t = z.unknown();
      }
      if (spec.description) t = t.describe(spec.description);
      shape[key] = def.parameters.required?.includes(key) ? t : t.optional();
    }
    return shape;
  }
}
