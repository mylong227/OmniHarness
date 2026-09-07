import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { LineTransport, type Transport } from '../server/lineTransport.js';

/**
 * @beta
 * 外部 MCP 服务器启动参数。
 */
export interface McpStdioServerOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Record<string, string>;
  readonly cwd?: string;
}

/**
 * @beta
 * 已启动的 MCP 服务器句柄。
 */
export interface McpStdioHandle {
  readonly transport: Transport;
  readonly process: ChildProcess;
  /** 启动失败或进程提前退出时 reject（竞速用，已内部吞掉未处理拒绝）。 */
  readonly failure: Promise<never>;
  readonly close: () => void;
}

/**
 * @beta
 * stdio 传输启动器：spawn 外部 MCP 服务器并以行式 JSON-RPC 通信。
 */
export class McpStdioTransport {
  /** 启动子进程并建立传输。 */
  static launch(options: McpStdioServerOptions): McpStdioHandle {
    const child = spawn(options.command, [...(options.args ?? [])], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
    });
    const stdout = child.stdout;
    const stdin = child.stdin;
    if (stdout === null || stdin === null) {
      throw new Error('MCP 子进程 stdio 管道不可用');
    }
    const reader = createInterface({ input: stdout, crlfDelay: Infinity });
    const transport = new LineTransport(
      (onLine) => {
        reader.on('line', onLine);
      },
      (line) => stdin.write(`${line}\n`),
    );
    return {
      transport,
      process: child,
      failure: this.failureOf(child),
      close: () => {
        reader.close();
        child.kill();
      },
    };
  }

  /** 进程失败信号：spawn 错误或提前退出（未处理拒绝已吞掉）。 */
  private static failureOf(child: ChildProcess): Promise<never> {
    const failure = new Promise<never>((_resolve, reject) => {
      child.on('error', (error: Error) => reject(error));
      child.on('exit', (code: number | null) =>
        reject(new Error(`MCP 服务器进程退出，代码 ${String(code)}`)),
      );
    });
    failure.catch(() => undefined);
    return failure;
  }
}
