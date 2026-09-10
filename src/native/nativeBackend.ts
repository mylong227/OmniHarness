// 原生后端（FFI 接入真实 agent 循环 #66）：把工具执行（含审批→沙箱→执行 全链）
// 路由到 Rust 内核 in-process，TS 侧 recorder 仍为事件源。内核不可用或内部失败时，
// 调用方（StepRunner）自动回退 JS 路径——fail-closed，绝不静默丢弃工具调用。
//
// 零新增运行时依赖：底层 NativeKernel 经 Node 内置 require() 加载手写 N-API 插件
// （native/omni_napi.node，GNU 工具链编译，无需 MSVC），不引入任何第三方 FFI 库。

import type { ToolCall, ToolResult } from '../ports/tool.js';
import type { NativeDecision } from './nativeKernel.js';
import { NativeKernel } from './nativeKernel.js';

/**
 * @beta
 * 原生工具执行器最小面（便于测试注入 stub，解耦具体 NativeKernel）。
 */
export interface NativeToolRunner {
  /** 经 Rust 内核执行工具。内部失败（非业务拒绝）应抛错以触发 JS 回退。 */
  runTool(call: ToolCall): ToolResult;
  /** 经 Rust 内核批量估算消息 token 数（单次 FFI 往返）。可选，缺省回退 JS。 */
  estimateTokens?(messages: readonly { content: string }[]): number;
}

/**
 * 工具名别名桥（#72）：标准工具集的 JS 名 → Rust 内核出厂内置名。
 *
 * 标准 JS 工具（read_file / write_file / list_dir / shell）与内核自带
 * （fs.read_file / fs.write_file / fs.list_dir / shell.run）仅命名不同、
 * 参数形状完全一致（{path,content?} / {command}）。适配器在此翻译，使内核
 * 方言对上层透明——模型口述名与 TS 工具注册名均保持不变，路由层只做改名。
 *
 * 越界的未知名原样透传（交由内核判「未知工具」→ 业务拒绝 → JS 回退），
 * 不在此做「猜名字」，避免意外映射到内核危险工具。
 */
const TOOL_NAME_ALIASES: Readonly<Record<string, string>> = {
  read_file: 'fs.read_file',
  write_file: 'fs.write_file',
  list_dir: 'fs.list_dir',
  shell: 'shell.run',
};

/** 把 JS 工具名翻译成内核方言；无别名则原样返回。 */
function toNativeToolName(name: string): string {
  return TOOL_NAME_ALIASES[name] ?? name;
}

/**
 * @beta
 * 原生后端：Rust 内核 in-process 执行工具。
 */
export class NativeBackend implements NativeToolRunner {
  private constructor(private readonly kernel: NativeKernel) {}

  /** 尝试创建：内核不可用（.node 未构建/加载失败）或 ping 失败则返 undefined（静默回退 JS）。 */
  public static tryCreate(): NativeBackend | undefined {
    const kernel = new NativeKernel();
    if (!kernel.available()) {
      return undefined;
    }
    try {
      kernel.ping();
    } catch {
      return undefined;
    }
    return new NativeBackend(kernel);
  }

  /** 经 Rust 内核走 审批→沙箱→执行 全链。
   * - 业务拒绝（rejected）：返回 ok:false + 拒绝原因，不抛错（合法结果）。
   * - 内核内部失败（ok:false 且未 rejected）：抛错，交由调用方回退 JS 路径。 */
  public runTool(call: ToolCall): ToolResult {
    // 命名桥：把 JS 标准工具名翻译成内核方言（#72）。内核找不到该名会判未知工具 → 业务拒绝。
    const nativeName = toNativeToolName(call.name);
    const r = this.kernel.toolCall(nativeName, call.arguments, call.id);
    if (!r.ok && !r.rejected) {
      throw new Error(`原生内核执行失败: ${r.output}`);
    }
    return {
      callId: call.id,
      ok: r.ok,
      output: r.ok ? r.output : undefined,
      error: r.ok ? undefined : r.output,
    };
  }

  /** 经 Rust 内核批量估算消息 token 数（单次 FFI 往返）。 */
  public estimateTokens(messages: readonly { content: string }[]): number {
    return this.kernel.estimateTokens(messages);
  }

  /** 经 Rust 内核渲染上下文并估算 token 数（单次 FFI 往返，算子下沉 #C4）。 */
  public contextRender(): { tokens: number; context: string } {
    return this.kernel.contextRender();
  }

  /** 经 Rust 内核对一次工具调用做审批裁决（不改状态，算子下沉 #C4）。 */
  public approvalCheck(name: string, args: Record<string, unknown>): NativeDecision {
    return this.kernel.approvalCheck(name, args);
  }
}
