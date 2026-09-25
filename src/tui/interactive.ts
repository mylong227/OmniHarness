/**
 * 零依赖 TUI 交互会话（#S35，对标 codex-rs/tui 的交互概念）。
 *
 * 仅用 Node 内置 `node:readline` / `node:tty` / `node:stream`，零外部依赖。把事件流渲染为
 * 终端行（复用 `render.ts`），并读取用户单行输入。适用于交互式 agent 会话的前端。
 */
import { createInterface, type Interface } from 'node:readline';
import type { Writable } from 'node:stream';
import { TuiRenderer, type TuiEvent } from './tuiRenderer.js';

/**
 * Interactive —— 由本文件原顶层函数归并而来（每个方法对应一个原函数，语义与签名逐字保留）。
 */
export class Interactive {
  /** 把事件流渲染到可写流（纯消费，便于单测用内存流验证）。 */
  public static async renderStream(events: AsyncIterable<TuiEvent>, out: Writable): Promise<void> {
    for await (const ev of events) {
      out.write(`${TuiRenderer.renderEventLine(ev)}\n`);
    }
  }

  /**
   * 启动交互式会话。需要 TTY（非 TTY 时抛错，由调用方 fail-closed 降级）。
   * 每行用户输入交给 `send`，渲染其事件流，直到输入退出词或 EOF。
   */
  public static async startInteractive(opts: InteractiveOptions): Promise<void> {
    const out = opts.out ?? process.stdout;
    const exitWords = opts.exitWords ?? ['exit', 'quit'];
    const rl = opts.rl ?? createInterface({ input: process.stdin, output: out, terminal: true });
    out.write(`${TuiRenderer.renderStatusLine('就绪', '输入消息开始；exit/quit 退出')}\n`);
    try {
      while (true) {
        const input = await new Promise<string | null>((resolve) => {
          rl.question(TuiRenderer.prompt(), (answer) => resolve(answer));
        });
        if (input === null) break; // EOF
        const trimmed = input.trim();
        if (trimmed === '') continue;
        if (exitWords.includes(trimmed.toLowerCase())) break;
        out.write(TuiRenderer.clearLine());
        try {
          await Interactive.renderStream(opts.send(trimmed), out);
        } catch (err) {
          out.write(
            `${TuiRenderer.renderEventLine({ kind: 'error', text: `处理失败: ${(err as Error).message}` })}\n`,
          );
        }
      }
    } finally {
      if (opts.rl === undefined) rl.close();
      out.write(`${TuiRenderer.renderStatusLine('已退出')}\n`);
    }
  }
}

/**
 * @beta
 * 交互会话选项。
 */
export interface InteractiveOptions {
  /** 处理用户输入、产出事件流（如调用 Agent 主循环）。 */
  readonly send: (input: string) => AsyncIterable<TuiEvent>;
  /** 输出流（缺省 process.stdout）。 */
  readonly out?: Writable;
  /** 输入接口（缺省按 process.stdin/stdout 新建 readline）。 */
  readonly rl?: Interface;
  /** 退出关键字（缺省 exit/quit）。 */
  readonly exitWords?: readonly string[];
}
