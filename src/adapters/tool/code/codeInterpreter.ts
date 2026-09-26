import { Worker } from 'node:worker_threads';
import type { ToolCall, ToolResult } from '../../../ports/tool/tool.js';

/**
 * @beta
 * 代码解释器依赖。
 */
export interface CodeInterpreterDeps {
  /** 程序内 `call(name, args)` 的执行后端（宿主侧，经门禁）。 */
  readonly execute: (call: ToolCall) => Promise<ToolResult>;
  /**
   * 单次执行的**硬超时**（毫秒，缺省 {@link CodeInterpreter.DEFAULT_TIMEOUT_MS}）。
   *
   * 语义（2026-09-26 审计 S3）：到期即 `terminate()` 掉整个 Worker —— 这是**唯一**能中止
   * `while(true){}` 的手段（在主线程里连定时器都跑不起来）。
   */
  readonly timeoutMs?: number | undefined;
}

/**
 * @beta
 * 代码运行结果。
 */
export interface CodeRunResult {
  readonly ok: boolean;
  readonly output: string;
  readonly calls: number;
}

/** 沙箱发来的消息（与 `codeSandboxWorker.ts` 的协议一一对应）。 */
type SandboxMessage =
  | {
      readonly kind: 'call';
      readonly seq: number;
      readonly name: string;
      readonly args: Record<string, unknown>;
    }
  | { readonly kind: 'log'; readonly text: string }
  | { readonly kind: 'done'; readonly ok: boolean; readonly output: string };

/**
 * @beta
 * 代码解释器：在 **worker_threads 沙箱**里执行程序，桥接 `call`/`log`（PTC/Code mode 核心，零外部依赖）。
 *
 * 为什么不直用 `new Function`（旧实现，2026-09-26 审计 S3）：模型写的代码在主线程跑，
 * 一句 `while(true){}` 就把事件循环永久占住 —— 超时定时器与取消令牌都在同一条循环上，
 * 谁也救不回来。放进 Worker 后，宿主只剩「转发消息 + 到点 terminate」，死循环可被有界中止。
 */
export class CodeInterpreter {
  /** 默认硬超时（毫秒）：30 秒（与 shell 默认超时同量级）。 */
  public static readonly DEFAULT_TIMEOUT_MS = 30_000;

  /**
   * 运行程序（程序内可用 `await call("tool", args)` 与 `log(...)`）。
   * @param code 待执行的 JS 程序体。
   * @param deps 工具执行依赖（execute 回调 + 可选超时）。
   * @returns 运行结果（输出 / 日志 / 调用计数）。
   */
  public async run(code: string, deps: CodeInterpreterDeps): Promise<CodeRunResult> {
    const logs: string[] = [];
    let calls = 0;
    const logsFromWorker: string[] = [];
    const timeoutMs = this.effectiveTimeout(deps.timeoutMs);

    const worker = new Worker(new URL('./codeSandboxWorker.js', import.meta.url), {
      workerData: { code },
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void worker.terminate();
    }, timeoutMs);

    return await new Promise<CodeRunResult>((resolve) => {
      const finish = (ok: boolean, output: string): void => {
        clearTimeout(timer);
        void worker.terminate();
        resolve({ ok, output, calls });
      };
      worker.on('message', (raw: SandboxMessage) => {
        if (raw.kind === 'log') {
          logsFromWorker.push(raw.text);
          return;
        }
        if (raw.kind === 'done') {
          finish(raw.ok, raw.output);
          return;
        }
        void this.handleCall(raw, deps).then((reply) => {
          calls += 1;
          worker.postMessage(reply);
        });
      });
      worker.on('error', (error: Error) => {
        finish(false, logs.concat([`执行错误: ${error.message}`]).join('\n'));
      });
      worker.on('exit', () => {
        if (timedOut) {
          finish(
            false,
            logsFromWorker
              .concat([`执行超时：已强制终止（上限 ${String(timeoutMs)}ms）`])
              .join('\n'),
          );
          return;
        }
        // 正常路径的 done 已经 resolve；这里只兜住「未发 done 就退出」的异常形态。
        finish(false, logsFromWorker.join('\n'));
      });
    });
  }

  /**
   * 处理沙箱发来的工具调用请求（宿主侧执行，异常收敛为失败回执）。
   * @param message 调用请求。
   * @param deps 依赖（execute 后端）。
   * @returns 回执消息（成功带 output，失败带 error）。
   */
  private async handleCall(
    message: Extract<SandboxMessage, { kind: 'call' }>,
    deps: CodeInterpreterDeps,
  ): Promise<{ kind: 'result'; seq: number; ok: boolean; output?: string; error?: string }> {
    try {
      const result = await deps.execute({
        id: `code_${String(message.seq)}`,
        name: message.name,
        arguments: message.args ?? {},
      });
      if (!result.ok) {
        return {
          kind: 'result',
          seq: message.seq,
          ok: false,
          error: `工具 ${message.name} 失败: ${result.error ?? '未知错误'}`,
        };
      }
      return { kind: 'result', seq: message.seq, ok: true, output: result.output ?? '' };
    } catch (error) {
      return {
        kind: 'result',
        seq: message.seq,
        ok: false,
        error: `工具 ${message.name} 失败: ${this.messageOf(error)}`,
      };
    }
  }

  /**
   * 解析生效超时：非法值（非正 / 非有限）回落默认 —— 绝不把 NaN 透给定时器
   * （`setTimeout(NaN)` 退化为 1ms，表现为「代码立刻超时」，极难归因）。
   * @param requested 调用方给出的毫秒数。
   * @returns 生效超时毫秒数。
   */
  private effectiveTimeout(requested: number | undefined): number {
    if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
      return CodeInterpreter.DEFAULT_TIMEOUT_MS;
    }
    return Math.floor(requested);
  }

  /**
   * 把运行期错误转为单行可读摘要。
   * @param error 捕获到的错误
   * @returns 单行错误摘要
   */
  private messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
