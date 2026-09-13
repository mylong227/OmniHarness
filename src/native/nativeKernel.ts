// 原生内核（FFI 下沉 #65）：Node 进程内直调 Rust 内核（N-API / .node）。
//
// 零新增运行时依赖：Node 内置 require() 加载 native/omni_napi.node（GNU 工具链
// 手写 N-API 插件，无需 MSVC），不引入任何第三方 FFI 库，维持「TS 零运行时依赖」铁律。
// 与 omni-wasm 同一套 JSON-RPC 面，但 native 具备完整系统 API（真实时钟/进程/
// RestrictedToken OS 沙箱/shell.run 真执行）。

import { NativeKernelUnavailableError } from './nativeKernelUnavailableError.js';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * @beta
 * 原生内核不可用（.node 未构建或加载失败）——fail-closed，调用即抛。
 */

/** N-API 插件暴露的最小面。 */
interface NativeModule {
  call: (json: string) => string;
}

/**
 * @beta
 * 审批裁决（与 Rust RuleDecision 对齐）。
 */
export interface NativeDecision {
  decision: 'allow' | 'deny' | 'ask';
  [key: string]: unknown;
}

/**
 * @beta
 * 原生内核客户端：同步 in-process 调用 Rust 内核。
 */
export class NativeKernel {
  /** 解析出的 .node 插件绝对路径（源码位 / dist 位取先存在者，未加载时也是构建指引依据）。 */
  private readonly pluginPath: string;
  /** 已加载的 N-API 插件句柄；未构建或加载失败时为 undefined（available() 返回 false）。 */
  private readonly mod: NativeModule | undefined;

  /** 构造：加载 native/omni_napi.node；失败不抛错，available() 返回 false。 */
  public constructor() {
    // 源码位（src/native/）向上 2 级 = 根；编译产物位（dist/src/native/）向上 3 级 = 根。
    const here = dirname(fileURLToPath(import.meta.url));
    const srcPath = join(here, '..', '..', 'native', 'omni_napi.node');
    const distPath = join(here, '..', '..', '..', 'native', 'omni_napi.node');
    this.pluginPath = existsSync(srcPath) ? srcPath : distPath;
    let mod: NativeModule | undefined;
    try {
      if (existsSync(this.pluginPath)) {
        const loaded = createRequire(import.meta.url)(this.pluginPath) as unknown;
        mod = loaded as NativeModule;
        if (typeof mod.call !== 'function') {
          mod = undefined;
        }
      }
    } catch {
      mod = undefined;
    }
    this.mod = mod;
  }

  /**
   * 内核是否可用（.node 已构建且加载成功）。
   * @returns 可用返回 true；否则 false（此时调用 call 系方法将抛 NativeKernelUnavailableError）。
   */
  public available(): boolean {
    return this.mod !== undefined;
  }

  /**
   * 插件文件路径（未加载时也是给出构建指引的依据）。
   * @returns 解析出的 omni_napi.node 绝对路径。
   */
  public modulePath(): string {
    return this.pluginPath;
  }

  /**
   * 底层 JSON-RPC 调用（同步；热路径专用）。ok=false 即抛错（fail-closed）。
   * @param method 内核方法名（如 'ping'、'tools.list'）。
   * @param params 方法参数（可选，随 JSON-RPC 请求透传给 Rust 侧）。
   * @returns 内核响应对象（ok=false 时已抛错，不会以失败态返回）。
   */
  public call(method: string, params?: Record<string, unknown>): Record<string, unknown> {
    const parsed = this.rawCall(method, params);
    if (parsed.ok !== true) {
      throw new Error(String(parsed.error ?? '原生内核调用失败'));
    }
    return parsed;
  }

  /**
   * 底层 JSON-RPC（不抛错，原样返回；由调用方判断 ok——工具执行被拒是合法业务结果）。
   * @param method 内核方法名（如 'tool_call'）。
   * @param params 方法参数（可选）。
   * @returns 内核响应原样解析结果（调用方自行读取 ok 字段）。
   */
  private rawCall(method: string, params?: Record<string, unknown>): Record<string, unknown> {
    const mod = this.mod;
    if (mod === undefined) {
      throw new NativeKernelUnavailableError(
        `原生内核未加载（${this.pluginPath}）——请先运行 npm run native:build`,
      );
    }
    const raw = mod.call(JSON.stringify({ method, params }));
    return JSON.parse(raw) as Record<string, unknown>;
  }

  /**
   * ping：验证插件加载与往返。
   * @returns `{ ok, pong, native }` — 插件加载、JSON-RPC 往返与 native 标志三重验证。
   */
  public ping(): { ok: boolean; pong: boolean; native: boolean } {
    return this.call('ping') as unknown as { ok: boolean; pong: boolean; native: boolean };
  }

  /**
   * 内核注册的工具元数据（native 含 shell.run，共 7 个）。
   * @returns 工具元描述数组（名称、参数 schema 等）。
   */
  public toolsList(): unknown[] {
    return this.call('tools.list').tools as unknown[];
  }

  /**
   * 提交一条 Submission 并驱动状态机，返回出站 Op。
   * @param submission 待提交的会话输入（用户消息等）。
   * @returns 驱动状态机后产生的出站 Op 数组。
   */
  public sessionSubmit(submission: unknown): unknown[] {
    return this.call('session.submit', { submission }).ops as unknown[];
  }

  /**
   * 取出尚未消费的出站操作。
   * @returns 待消费的出站 Op 数组（取后由调用方负责处理）。
   */
  public sessionOps(): unknown[] {
    return this.call('session.ops').ops as unknown[];
  }

  /**
   * 模型可见上下文与 token 估算。
   * @returns `{ tokens, context }` — 估算 token 数与渲染后的上下文文本。
   */
  public contextRender(): { tokens: number; context: string } {
    const r = this.call('context.render');
    return { tokens: r.tokens as number, context: r.context as string };
  }

  /**
   * 批量估算消息 token 数（对齐 TS TokenEstimator.estimateMessages，单次 FFI 往返）。
   * @param messages 消息数组（仅需 content 字段参与估算）。
   * @returns 估算的 token 总数。
   */
  public estimateTokens(messages: readonly { content: string }[]): number {
    const r = this.call('context.estimate', { messages });
    return r.tokens as number;
  }

  /**
   * 对一次工具调用做审批裁决（不改状态）。
   * @param name 工具名。
   * @param args 工具参数。
   * @returns 裁决结果（decision: 'allow' | 'deny' | 'ask'，与 Rust RuleDecision 对齐）。
   */
  public approvalCheck(name: string, args: Record<string, unknown>): NativeDecision {
    return this.call('approval.check', { name, args }).decision as NativeDecision;
  }

  /**
   * 直接执行一次工具（审批 → 策略沙箱 → OS 沙箱 → 执行 → 记录 全链）。被拒是合法结果。
   * @param name 工具名。
   * @param args 工具参数。
   * @param callId 本次调用唯一标识（内核侧记录与关联用）。
   * @returns `{ ok, output, wrapped, rejected, ops }` — 成败、输出文本、是否经 OS 沙箱包装、是否被拒、产生的出站 Op。
   */
  public toolCall(
    name: string,
    args: Record<string, unknown>,
    callId: string,
  ): { ok: boolean; output: string; wrapped: boolean; rejected: boolean; ops: unknown[] } {
    const r = this.rawCall('tool_call', { name, args, callId });
    return {
      ok: r.ok === true,
      output: String(r.output ?? ''),
      wrapped: r.wrapped === true,
      rejected: r.rejected === true,
      ops: r.ops as unknown[],
    };
  }
}
export { NativeKernelUnavailableError };
