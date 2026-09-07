import type { ToolCall, ToolContext, ToolDefinition, ToolPort, ToolResult } from '../ports/tool.js';
import type { ToolGate } from '../core/toolGate.js';
import { CodeInterpreter } from './codeInterpreter.js';

/**
 * @beta
 * 代码执行器选项：门禁 + 工具端口（程序内调用同样过门禁）。
 */
export interface CodeExecutorOptions {
  readonly gate: ToolGate;
  readonly tools: ToolPort;
}

/**
 * @beta
 * 代码执行工具：模型写一段程序一次执行多步工具调用（省 token，PTC 模式）。
 */
export class CodeExecutorTool {
  /** 工具定义。 */
  readonly definition: ToolDefinition = {
    name: 'run_code',
    description:
      '执行一段 TypeScript/JavaScript 程序；程序内可用 await call("工具名", 参数) 调用工具、log(...) 输出',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '要执行的程序代码' },
      },
      required: ['code'],
    },
  };

  private readonly interpreter = new CodeInterpreter();

  constructor(private readonly options: CodeExecutorOptions) {}

  /** 执行程序。 */
  async handle(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    const code = String(call.arguments['code'] ?? '');
    const result = await this.interpreter.run(code, {
      execute: (inner) => this.executeGated(inner, context),
    });
    return { callId: call.id, ok: result.ok, output: result.output };
  }

  /** 经门禁执行工具调用。 */
  private async executeGated(inner: ToolCall, context: ToolContext): Promise<ToolResult> {
    const denied = await this.options.gate.gate(inner, context.sessionId);
    if (denied !== undefined) {
      return denied;
    }
    return this.options.tools.execute(inner, context);
  }
}
