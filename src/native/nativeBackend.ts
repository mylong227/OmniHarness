// 原生后端（FFI 接入真实 agent 循环 #66）：把**语义等价**的工具执行（含审批→沙箱→执行
// 全链）路由到 Rust 内核 in-process，TS 侧 recorder 仍为事件源。内核不可用或内部失败时，
// 调用方（StepRunner）自动回退 JS 路径——fail-closed，绝不静默丢弃工具调用。
//
// 2026-10-21：`--native` 默认仍开，但工具执行已全部回退 JS（`supports()` 恒 false）——
// 内核 fs.* 与 JS 工具语义不等价（offset/limit、行号、64 MiB 上限、.bak、mkdir -p、
// 内容账本）。`--native` 现在保留的真实收益是 `estimateTokens` 的 FFI 下沉。
// 待某个工具逐字节等价后，再加回 `TOOL_NAME_ALIASES` 并让 `supports()` 放行。
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
 * 工具名别名桥（#66、#72）：标准工具集的 JS 名 → Rust 内核出厂内置名。
 *
 * **2026-10-21 起为空**：现有内核内置工具与 JS 工具**语义不等价**，不能直接接管：
 *  - `fs.read_file` 只认 `path`，忽略 `offset/limit/numbered`，无行号脚注、无 64 MiB 上限、
 *    也不写入 `FileContentLedger`（写类工具的冲突检测因此失效）；
 *  - `fs.write_file` 不做 `.bak` 备份、不 `mkdir -p`、同样不记账；
 *  - `fs.list_dir` 返回 JSON，而 JS 工具返回 `[d]/[f]` 行格式；
 *  - `shell.run` 无超时/取消，非零退出还被映射成成功（StepToolExecutor 已显式禁用）。
 *
 * 在补齐语义之前一律走 JS：`supports()` 恒 false，调用方据此跳过原生执行。
 * `--native` 仍保留其真实收益——`estimateTokens` 的 FFI 下沉（见 `agentCompactor`）。
 * 未来某个工具做到逐字节等价时，再把它加回本表并让 `supports()` 返回 true。
 */
const TOOL_NAME_ALIASES: Readonly<Record<string, string>> = {};

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

  /**
   * 本后端是否声明对该 JS 工具名具备**语义等价**的执行能力。
   *
   * 2026-10-21 起恒 false：见 {@link TOOL_NAME_ALIASES} 的语义差异清单。调用方
   * （`StepToolExecutor`）据此跳过原生执行，避免「默认 --native 把 read_file 的
   * offset/limit 吃掉、把 write_file 的备份与冲突检测绕过」这类静默失真。
   * @param _toolName JS 侧工具名。
   * @returns 恒 false（待某个工具做到逐字节等价后再按表放行）。
   */
  public supports(_toolName: string): boolean {
    return false;
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
