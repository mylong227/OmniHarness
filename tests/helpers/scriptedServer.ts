/**
 * MCP 连接器判据的**进程内假传输**夹具（2026-10-11 从 `sdkMcpConnector.test.ts` 抽出）。
 *
 * 抽出的直接原因：那个测试文件涨到 756 行、含多个类 ⇒ 命中本仓编码标准的"上帝类"判据
 * （`codeLines > 500 && classes > 0`，按**文件**计）。抽到这里后两边都在阈值内，
 * 且夹具可被后续 MCP 判据复用。
 *
 * 口径不变：出站 JSON-RPC 由 `ScriptedServer` 脚本化应答，握手仍走**真 SDK `Client`**。
 */
import type { McpServerConfig } from '../../src/ports/mcp/mcpServerConfig.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/** 出站请求帧（假传输按方法应答时只关心这三项）。 */
export interface OutboundRequest {
  readonly id: string | number;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

/** 假服务端给出的一条应答（`undefined` = 故意不响应，用于超时/断线判据）。 */
export type Outcome =
  | { readonly result: unknown }
  | { readonly error: { readonly code: number; readonly message: string } }
  | undefined;

/** 假 MCP 服务端：握手默认应答，其余方法逐条脚本化。 */
export class ScriptedServer {
  /** 各方法的应答脚本（未登记的方法 ⇒ 不响应）。 */
  public readonly methods = new Map<string, Outcome>();
  /** 收到的 initialize 参数（判据①用）。 */
  public readonly initializeParams: Record<string, unknown>[] = [];

  public constructor(
    private readonly initResult: Record<string, unknown> = {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {}, resources: {}, prompts: {} },
      serverInfo: { name: 'fake-mcp', version: '9.9.9' },
    },
  ) {}

  /**
   * 应答一条出站请求。
   * @param frame 出站请求帧。
   * @returns 应答；undefined 表示不响应。
   */
  public respond(frame: OutboundRequest): Outcome {
    if (frame.method === 'initialize') {
      this.initializeParams.push(frame.params);
    }
    // 显式脚本优先（含"让 initialize 失败"的场景），未脚本化时 initialize 默认成功。
    if (this.methods.has(frame.method)) {
      return this.methods.get(frame.method);
    }
    return frame.method === 'initialize' ? { result: this.initResult } : undefined;
  }
}

/** 进程内假传输：`send` 立即（同步）把脚本应答回灌给 SDK 的 onmessage。 */
export class FakeTransport implements Transport {
  /** 收到的全部出站消息（含通知）。 */
  public readonly sent: JSONRPCMessage[] = [];
  /** `close()` 调用次数。 */
  public closeCount = 0;
  /** `start()` 调用次数。 */
  public startCount = 0;
  /** SDK 协商出的协议版本（`setProtocolVersion` 被调用时记录）。 */
  public readonly negotiated: string[] = [];
  /** 传输层错误回调（SDK 装配）。 */
  public onerror?: (error: Error) => void;
  /** 传输关闭回调（SDK 装配；假服务端断线时手动触发）。 */
  public onclose?: () => void;
  /** 入站消息回调（SDK 装配）。 */
  public onmessage?: <T extends JSONRPCMessage>(message: T) => void;
  /** 非空则 `start()` 直接抛出（判据⑧的"只看连接器能不能兜"）。 */
  private startError: Error | undefined;
  /** 非空则 `close()` 抛出（判据⑧：回收动作自身失败**不得掩盖**真实原因）。 */
  private closeError: Error | undefined;

  public constructor(private readonly server: ScriptedServer) {}

  /**
   * 启动（无 I/O，仅计数；可用 {@link failStart} 注入启动失败）。
   * @returns 无返回值。
   */
  public async start(): Promise<void> {
    this.startCount += 1;
    if (this.startError !== undefined) {
      throw this.startError;
    }
  }

  /**
   * 发送一条 JSON-RPC 消息，并把脚本应答回灌。
   * @param message 出站消息。
   * @returns 无返回值。
   */
  public async send(message: JSONRPCMessage): Promise<void> {
    this.sent.push(message);
    if (!('method' in message) || !('id' in message)) {
      return; // 通知没有应答语义
    }
    const frame: OutboundRequest = {
      id: message.id,
      method: message.method,
      params: (message.params ?? {}) as Record<string, unknown>,
    };
    const outcome = this.server.respond(frame);
    if (outcome === undefined) {
      return; // 故意不响应 ⇒ 交给超时 / 断线判据
    }
    this.onmessage?.({ jsonrpc: '2.0', id: frame.id, ...outcome } as JSONRPCMessage);
  }

  /**
   * 关闭传输（可用 {@link failClose} 注入回收失败）。
   * @returns 无返回值。
   */
  public async close(): Promise<void> {
    this.closeCount += 1;
    if (this.closeError !== undefined) {
      throw this.closeError;
    }
  }

  /**
   * 令 `start()` 抛出（判据⑧用：SDK 的 `super.connect()` 在自己的 try 之外，
   * 这条失败**只有连接器**兜得住）。
   *
   * @param error 启动失败原因。
   * @returns 无返回值。
   */
  public failStart(error: Error): void {
    this.startError = error;
  }

  /**
   * 令 `close()` 抛出（判据⑧用：回收失败不得掩盖真实原因）。
   *
   * @param error 回收失败原因。
   * @returns 无返回值。
   */
  public failClose(error: Error): void {
    this.closeError = error;
  }

  /**
   * 记录 SDK 协商出的协议版本。
   *
   * @param version 协商版本。
   * @returns 无返回值。
   */
  public setProtocolVersion(version: string): void {
    this.negotiated.push(version);
  }

  /**
   * 已发出的请求方法序列（过滤通知）。
   *
   * @returns 按发出顺序排列的方法名数组。
   */
  public methodSequence(): string[] {
    return this.sent
      .filter((message): message is JSONRPCMessage & { method: string } => 'method' in message)
      .map((message) => message.method);
  }
}

/** 注入缝：记录工厂收到的实参，返回同一个假传输（或每次新建）。 */
export class RecordingFactory {
  /** 每次调用收到的实参。 */
  public readonly calls: unknown[] = [];
  /** 由工厂创建出的全部传输。 */
  public readonly created: FakeTransport[] = [];

  public constructor(private readonly make: (arg: unknown) => FakeTransport) {}

  /**
   * 传输工厂（注入给连接器）。
   * @param arg 连接器传入的实参（stdio 给 StdioServerParameters，远端给 URL）。
   * @returns 假传输。
   */
  public readonly create = (arg: unknown): Transport => {
    this.calls.push(arg);
    const transport = this.make(arg);
    this.created.push(transport);
    return transport;
  };
}

/** 采集 stderr 的结构化日志行（`log` 单例写 stderr）。 */
export async function captureStderr(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
    return lines;
  } finally {
    process.stderr.write = original;
  }
}

/** 解析采集到的 JSON 日志行（非 JSON 行原样丢弃）。 */
export function parseLogLines(lines: readonly string[]): Record<string, unknown>[] {
  const parsed: Record<string, unknown>[] = [];
  for (const line of lines) {
    for (const piece of line.split('\n')) {
      const trimmed = piece.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        parsed.push(JSON.parse(trimmed) as Record<string, unknown>);
      } catch {
        // 非 JSON 行（本仓日志约定外的输出）忽略
      }
    }
  }
  return parsed;
}

/** stdio 形态的服务器配置。 */
export function stdioServer(extra: Partial<McpServerConfig> = {}): McpServerConfig {
  return { name: 'local', command: 'node', ...extra };
}

/** 远端形态的服务器配置。 */
export function remoteServer(url = 'http://127.0.0.1:9/mcp'): McpServerConfig {
  return { name: 'remote', url };
}

/** 等待若干个事件循环轮次（关闭/断线是异步收尾）。 */
export async function settle(rounds = 4): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
