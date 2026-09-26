import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { LineTransport, type Transport } from '../server/transport/lineTransport.js';
import { ProcessTreeKiller } from '../adapters/tool/shell/processTreeKiller.js';
import { log } from '../util/logger.js';

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
 *
 * 无状态启动逻辑以实例方法暴露，由组合根单例 `mcpStdioTransport` 统一装配。
 */
export class McpStdioTransport {
  /** 启动子进程并建立传输。 */
  public launch(options: McpStdioServerOptions): McpStdioHandle {
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
    // stdin 也必须接 'error'（2026-09-26 审计 S6）：对端已死时 `stdin.write` 会发 EPIPE，
    // 无监听时它就是 uncaughtException —— **整个宿主进程被一个子进程带走**。
    stdin.on('error', (error: Error) => {
      log.warn('mcp.stdio.stdinFailed', { error: error.message });
    });
    const transport = new LineTransport(
      (onLine) => {
        reader.on('line', onLine);
      },
      (line) => {
        if (stdin.writable) {
          stdin.write(`${line}\n`);
        }
      },
    );
    return {
      transport,
      process: child,
      failure: this.failureOf(child),
      close: () => {
        reader.close();
        // 树杀而非 `child.kill()`（2026-09-26 审计 S6）：`npx @scope/server` 这类命令的直接子进程
        // 只是 wrapper，真正的 MCP 服务是它的孙进程 —— 只杀 wrapper 会留下孤儿常驻。
        // 仓内已有可用的跨平台树杀原语（Windows taskkill /T /F，POSIX 组杀），此处直接复用。
        if (child.pid !== undefined) {
          ProcessTreeKiller.killPid(child.pid);
        } else {
          child.kill();
        }
      },
    };
  }

  /** 进程失败信号：spawn 错误或提前退出（未处理拒绝已吞掉）。 */
  private failureOf(child: ChildProcess): Promise<never> {
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

/** 组合根单例：stdio 传输启动逻辑的装配点。 */
export const mcpStdioTransport = new McpStdioTransport();
