import type { ToolCall, ToolResult } from '../ports/tool.js';

/**
 * @beta
 * 代码解释器依赖。
 */
export interface CodeInterpreterDeps {
  readonly execute: (call: ToolCall) => Promise<ToolResult>;
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

/**
 * @beta
 * 代码解释器：执行程序，注入 call/log（PTC/Code mode 核心，零依赖）。
 */
export class CodeInterpreter {
  /** 运行程序（程序内可用 await call("tool", args) 与 log(...)）。 */
  async run(code: string, deps: CodeInterpreterDeps): Promise<CodeRunResult> {
    const logs: string[] = [];
    let calls = 0;
    const callFn = async (name: string, args: Record<string, unknown>): Promise<string> => {
      calls += 1;
      const result = await deps.execute({ id: `code_${calls}`, name, arguments: args ?? {} });
      if (!result.ok) {
        throw new Error(`工具 ${name} 失败: ${result.error ?? '未知错误'}`);
      }
      return result.output ?? '';
    };
    const logFn = (...parts: unknown[]): void => {
      logs.push(parts.map((part) => String(part)).join(' '));
    };
    try {
      const fn = new Function('call', 'log', `return (async () => { ${code} })();`);
      const returnValue = await fn(callFn, logFn);
      if (returnValue !== undefined) {
        logs.push(`返回值: ${JSON.stringify(returnValue)}`);
      }
      return { ok: true, output: logs.join('\n'), calls };
    } catch (error) {
      return {
        ok: false,
        output: logs.concat([`执行错误: ${this.messageOf(error)}`]).join('\n'),
        calls,
      };
    }
  }

  /** 提取错误消息。 */
  private messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
