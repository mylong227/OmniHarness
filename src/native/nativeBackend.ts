// 原生后端（FFI 接入真实 agent 循环 #66）：把工具执行（含审批→沙箱→执行 全链）
// 路由到 Rust 内核 in-process，TS 侧 recorder 仍为事件源。内核不可用或内部失败时，
// 调用方（StepRunner）自动回退 JS 路径——fail-closed，绝不静默丢弃工具调用。
//
// 零新增运行时依赖：底层 NativeKernel 经 Node 内置 require() 加载手写 N-API 插件
// （native/omni_napi.node，GNU 工具链编译，无需 MSVC），不引入任何第三方 FFI 库。

import type { ToolCall, ToolResult } from '../ports/tool/tool.ts';
import type { NativeToolRunner } from '../ports/native/nativeToolRunner.ts';
import type { NativeDecision } from './nativeKernel.ts';
import { NativeKernel } from './nativeKernel.ts';
import { log } from '../util/logger.ts';

export type { NativeToolRunner } from '../ports/native/nativeToolRunner.ts';

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

/**
 * @beta
 * 原生后端：Rust 内核 in-process 执行工具。
 */
export class NativeBackend implements NativeToolRunner {
  /** 内核是否支持 root.* 方法（旧 .node 不支持：首次探测失败即置 false，永不再试）。 */
  private rootApiSupported = true;

  /**
   * 私有构造：统一经 {@link tryCreate} 装配。
   * @param kernel 已就绪的内核客户端（参数属性，实例字段 `kernel`）
   */
  private constructor(private readonly kernel: NativeKernel) {}

  /**
   * 尝试创建：内核不可用（.node 未构建/加载失败）或 ping 失败则返 undefined（静默回退 JS）。
   * @returns 就绪的 NativeBackend；内核不可用时 undefined。
   */
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

  /**
   * 执行前把内核根对齐到期望的工作区根（2026-10-13「内核根跑偏」守门）。
   *
   * 缺陷原委：内核是**进程级全局静态**（OnceLock），进程 cwd 只在首次初始化读一次；serve 切换
   * 工作区只重基 JS 工具，内核根纹丝不动 ⇒ `fs.*` 经原生路径永远落在**启动目录**（真机：工作区
   * 里 `list_dir .` 列回宿主仓库的 tsconfig.json/crates；而内核失败的调用回退 JS 反而正确——
   * 两种输出格式混在同一回合，即用户截图所见）。故每次原生工具执行前先对账：根不一致就
   * `root.set` 纠偏。
   *
   * 容错：旧版 .node 没有 `root.get`/`root.set` 方法（未知方法错误）——记一次告警后置
   * {@link rootApiSupported}＝false 永不再试，保持原生加速与旧版行为逐字节一致（JS 回退仍兜底）。
   * 对账通过后 `runTool` 才会走内核；根对不齐且纠偏失败时抛错 → 调用方回退 JS（fail-closed 落到
   * 正确的根，绝不拿错误根的结果糊弄模型）。
   * @param expected 期望的工作区根（ToolContext.workspaceRoot）。
   * @returns 无返回值。
   */
  public syncWorkspaceRoot(expected: string): void {
    if (!this.rootApiSupported) {
      return;
    }
    try {
      const current = this.kernel.getRoot();
      if (current !== expected) {
        this.kernel.setWorkspaceRoot(expected);
        log.info('native.root.synced', { from: current, to: expected });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 只有「旧内核没有 root.* 方法」才永久降级；根对齐失败（权限/路径被拒）必须抛错，
      // 让 StepRunner 回退 JS（其根恒正确），绝不能带着**错误内核根**继续执行工具。
      if (/unknown method|method not found|-32601|not implemented|未实现/iu.test(message)) {
        this.rootApiSupported = false;
        log.warn('native.root.unsupported', {
          error: message,
          hint: '旧版 omni_napi.node 无 root.* 方法——请 npm run native:build 重建内核',
        });
        return;
      }
      log.warn('native.root.sync_failed', { expected, error: message });
      throw new Error(`原生内核工作区根对齐失败（回退 JS 执行）：${message}`);
    }
  }

  /** 经 Rust 内核走 审批→沙箱→执行 全链。
   * - 业务拒绝（rejected）：返回 ok:false + 拒绝原因，不抛错（合法结果）。
   * - 内核内部失败（ok:false 且未 rejected）：抛错，交由调用方回退 JS 路径。
   * @param call 工具调用（名称经别名桥翻译，参数与调用 id 原样透传）。
   * @returns 工具结果（callId + ok + output/error）。
   */
  public runTool(call: ToolCall): ToolResult {
    // 命名桥：把 JS 标准工具名翻译成内核方言（#72）。内核找不到该名会判未知工具 → 业务拒绝。
    const nativeName = NativeBackend.toNativeToolName(call.name);
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

  /**
   * 经 Rust 内核批量估算消息 token 数（单次 FFI 往返）。
   * @param messages 消息数组（仅需 content 字段）。
   * @returns 估算的 token 总数。
   */
  public estimateTokens(messages: readonly { content: string }[]): number {
    return this.kernel.estimateTokens(messages);
  }

  /**
   * 经 Rust 内核渲染上下文并估算 token 数（单次 FFI 往返，算子下沉 #C4）。
   * @returns `{ tokens, context }` — 估算 token 数与渲染后的上下文文本。
   */
  public contextRender(): { tokens: number; context: string } {
    return this.kernel.contextRender();
  }

  /**
   * 经 Rust 内核对一次工具调用做审批裁决（不改状态，算子下沉 #C4）。
   * @param name 工具名。
   * @param args 工具参数。
   * @returns 裁决结果（decision: 'allow' | 'deny' | 'ask'）。
   */
  public approvalCheck(name: string, args: Record<string, unknown>): NativeDecision {
    return this.kernel.approvalCheck(name, args);
  }

  /**
   * toNativeToolName — module-level helper moved into NativeBackend.
   * @param {string} name - name
   * @returns {string} - result
   */
  private static toNativeToolName(name: string): string {
    return TOOL_NAME_ALIASES[name] ?? name;
  }
}
