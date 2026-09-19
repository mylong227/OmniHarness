/**
 * sdk 子命令（SdkCommand）——用本仓 TypeScript SDK 客户端连真实 app-server 发一次 JSON-RPC。
 *
 * 事故口径（2026-09-19 入口可达性审计）：`src/sdk/sdkClient.ts`（JSON-RPC 客户端）与
 * `src/sdk/webSocketSdkSocket.ts`（WebSocket 传输）有实现、有单测，却**没有任何生产入口**
 * ——生成的 SDK 与外部消费方拿不到可用连接路径。本命令补上入口：
 * `omniharness sdk call --url ws://127.0.0.1:8787/ws --method model.catalog`。
 *
 * 与「生成 SDK 文本」（`schema` 子命令）的分工：那个产出代码，本命令**真的连上去打一发**，
 * 是「SDK 能力在真实传输上可用」的可执行证据。
 */
import { SdkClient } from '../sdk/sdkClient.js';
import { WebSocketSdkSocket, type SdkSocket } from '../sdk/webSocketSdkSocket.js';
import { CliArgReader } from './cliArgReader.js';

/** 用法提示。 */
const USAGE =
  '用法: omniharness sdk call --url ws://HOST:PORT/ws --method NAME [--params JSON] [--timeout MS]\n' +
  '      omniharness sdk ping --url ws://HOST:PORT/ws\n';

/**
 * `sdk ping` 打的服务端方法。
 *
 * 取 `config.get` 而不是自造 `ping`：app-server 没有 `ping` 方法（那是 MCP 协议的方法），
 * 探测必须打真实存在的最轻 RPC，否则「连通性检查」永远只得到「方法不存在」。
 */
const PING_METHOD = 'config.get';

/** SdkCommand 依赖（缺省走真实 WebSocket）。 */
export interface SdkCommandDeps {
  /** socket 工厂（缺省 {@link WebSocketSdkSocket.connect}；单测注入内存假 socket）。 */
  readonly connect?: ((url: string) => SdkSocket) | undefined;
  /** 输出通道（缺省 process.stdout）。 */
  readonly write?: ((text: string) => void) | undefined;
}

/** sdk 子命令：连 app-server 的 WS 端点发一次 JSON-RPC 并打印响应。 */
export class SdkCommand {
  /** socket 工厂。 */
  private readonly connect: (url: string) => SdkSocket;
  /** 输出通道。 */
  private readonly write: (text: string) => void;

  /**
   * @param deps socket 工厂与输出通道（均可缺省）
   */
  public constructor(deps: SdkCommandDeps = {}) {
    this.connect = deps.connect ?? ((url) => WebSocketSdkSocket.connect(url));
    this.write = deps.write ?? ((text) => process.stdout.write(text));
  }

  /**
   * 执行 sdk 子命令。
   * @param args 子命令参数（已去掉 `sdk`，首元素为子动作 `call` / `ping`）
   * @returns 进程退出码（0 成功 / 1 调用失败 / 2 用法错误）
   */
  public async run(args: readonly string[]): Promise<number> {
    if (args[0] !== 'call' && args[0] !== 'ping') {
      this.write(USAGE);
      return 2;
    }
    const reader = new CliArgReader(args.slice(1));
    const url = reader.value('--url');
    if (url === undefined || url.trim() === '') {
      this.write(USAGE);
      return 2;
    }
    try {
      const result = await this.dispatch(url, args[0], reader);
      this.write(`${JSON.stringify(result)}\n`);
      return 0;
    } catch (error) {
      process.stderr.write(
        `[omniharness] SDK 调用失败: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 1;
    }
  }

  /**
   * 按子动作分派：ping 打内建 `ping` 方法，call 走 --method / --params。
   * @param url WebSocket 端点
   * @param sub 子动作（`call` / `ping`）
   * @param reader 参数读取器
   * @returns 服务端 result 原文
   */
  private async dispatch(
    url: string,
    sub: 'call' | 'ping',
    reader: CliArgReader,
  ): Promise<unknown> {
    const method = sub === 'ping' ? PING_METHOD : this.methodOf(reader);
    const params = sub === 'ping' ? {} : this.parseParams(reader.value('--params'));
    return this.invoke(url, method, params, reader.value('--timeout'));
  }

  /**
   * 取 `--method`（缺失即报用法错误）。
   * @param reader 参数读取器
   * @returns RPC 方法名
   */
  private methodOf(reader: CliArgReader): string {
    const method = reader.value('--method');
    if (method === undefined || method.trim() === '') {
      throw new Error('sdk call 需要 --method');
    }
    return method;
  }

  /**
   * 建立连接、发一次 JSON-RPC、返回结果后关闭连接。
   * @param url WebSocket 端点
   * @param method RPC 方法名
   * @param params 方法参数对象
   * @param timeoutRaw `--timeout` 原始取值（缺省/非法走 SdkClient 内建超时）
   * @returns 服务端 result 原文
   */
  private async invoke(
    url: string,
    method: string,
    params: Record<string, unknown>,
    timeoutRaw: string | undefined,
  ): Promise<unknown> {
    const timeoutMs = SdkCommand.parseTimeout(timeoutRaw);
    const client = new SdkClient({
      socket: this.connect(url),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
    try {
      return await client.call<unknown>(method, params);
    } finally {
      client.close();
    }
  }

  /**
   * 解析 --params JSON（缺省空对象）。
   * @param raw 原始 JSON 文本
   * @returns 解析出的参数对象；文本须为 JSON 对象（数组/标量一律拒绝）
   */
  private parseParams(raw: string | undefined): Record<string, unknown> {
    if (raw === undefined || raw.trim() === '') {
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('--params 必须是 JSON 对象');
    }
    return parsed as Record<string, unknown>;
  }

  /**
   * 解析 --timeout（非正数/非数字按缺省处理）。
   * @param raw 原始取值
   * @returns 超时毫秒数；未提供或非法时 undefined（走 SdkClient 缺省）
   */
  private static parseTimeout(raw: string | undefined): number | undefined {
    if (raw === undefined) {
      return undefined;
    }
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }
}
