/**
 * `run_code` 的**沙箱执行体**（worker_threads 入口）。
 *
 * 为什么必须在 Worker 里跑（2026-09-26 审计 S3）：`CodeInterpreter` 原先用 `new Function(...)`
 * 在**主线程**执行模型写的代码 —— 一句 `while(true){}` 就把事件循环永久占住，**连取消令牌与
 * 超时定时器都触发不了**（它们同样跑在这个被占住的循环上）。搬进 Worker 后，宿主侧只剩一个
 * 定时器与 `terminate()`，任何死循环都能被有界中止。
 *
 * 通信协议（与 {@link ./codeInterpreter.ts} 的宿主侧一一对应）：
 * - worker → 宿主：`{ kind:'call', seq, name, args }`（请求代执行工具）、
 *   `{ kind:'log', text }`、`{ kind:'done', ok, output }`；
 * - 宿主 → worker：`{ kind:'result', seq, ok, output?, error? }`。
 *
 * 本文件刻意不做任何策略裁决：工具**是否允许调用**由宿主侧的门禁决定（见 `CodeExecutorTool`），
 * 沙箱只负责「把调用请求送出去、把结果拿回来」。
 */

import { parentPort, workerData } from 'node:worker_threads';

/** 宿主下发的初始化数据。 */
interface SandboxInit {
  /** 待执行的程序体。 */
  readonly code: string;
}

/** 宿主回传的单次工具调用结果。 */
interface CallResultMessage {
  readonly kind: 'result';
  readonly seq: number;
  readonly ok: boolean;
  readonly output?: string;
  readonly error?: string;
}

/** 沙箱运行器：静态方法族（无状态），由文件末尾一行启动。 */
class CodeSandboxWorker {
  /**
   * 执行程序体并把日志/工具调用桥回宿主。
   * @param port 与宿主通信的端口。
   * @param code 待执行的程序体。
   * @returns 无返回值（结果经端口送出）。
   */
  public static async main(port: NonNullable<typeof parentPort>, code: string): Promise<void> {
    const logs: string[] = [];
    let seq = 0;
    const pending = new Map<number, (message: CallResultMessage) => void>();
    port.on('message', (message: CallResultMessage): void => {
      if (message.kind !== 'result') {
        return;
      }
      const resolve = pending.get(message.seq);
      if (resolve !== undefined) {
        pending.delete(message.seq);
        resolve(message);
      }
    });
    const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
      seq += 1;
      const current = seq;
      const reply = new Promise<CallResultMessage>((resolve) => {
        pending.set(current, resolve);
      });
      port.postMessage({ kind: 'call', seq: current, name, args: args ?? {} });
      const message = await reply;
      if (!message.ok) {
        throw new Error(message.error ?? `工具 ${name} 失败`);
      }
      return message.output ?? '';
    };
    const log = (...parts: unknown[]): void => {
      const text = parts.map((part) => String(part)).join(' ');
      logs.push(text);
      port.postMessage({ kind: 'log', text });
    };
    try {
      // `indirect eval` 之外仍需动态编译源码：用 `new Function` 在**本 worker** 内构造
      // （主线程不再承担任何解释执行）。
      const fn = new Function('call', 'log', `return (async () => { ${code} })();`);
      const returnValue = await fn(call, log);
      if (returnValue !== undefined) {
        logs.push(`返回值: ${CodeSandboxWorker.stringify(returnValue)}`);
      }
      port.postMessage({ kind: 'done', ok: true, output: logs.join('\n') });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logs.push(`执行错误: ${message}`);
      port.postMessage({ kind: 'done', ok: false, output: logs.join('\n') });
    }
  }

  /**
   * 返回值字符串化：与改造前**逐字同口径**（`JSON.stringify`，仅在其失败时回落 `String`）——
   * 于是 `return "完成"` 仍输出 `返回值: "完成"`（带引号），既有契约与测试不受影响。
   * @param value 任意返回值。
   * @returns 可读文本。
   */
  private static stringify(value: unknown): string {
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  }
}

const port = parentPort;
if (port === null) {
  // 不是以 worker 方式被加载：静默退出（本文件只应作为 worker 入口）。
  process.exitCode = 1;
} else {
  const init = workerData as SandboxInit;
  await CodeSandboxWorker.main(port, String(init.code ?? ''));
}
