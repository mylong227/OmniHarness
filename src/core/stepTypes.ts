import type { ApprovalPort } from '../ports/runtime/approval.js';
import type { SandboxPort } from '../ports/runtime/sandbox.js';
import type { ToolPort } from '../ports/tool/tool.js';
import type { ModelPort } from '../ports/model/model.js';
import type { EscalationPort } from '../ports/runtime/escalation.js';
import type { EmbeddingPort } from '../ports/model/embedding.js';
import type { BudgetDegradeSignal } from '../ports/model/budgetDegrade.js';
import type { RepoMapContextEngine } from '../context/repoMapContextEngine.js';
import type { ToolResultSpiller } from '../context/toolResultSpiller.js';
import type { ContextCompactor } from '../context/contextCompactor.js';
import type { ToolGate } from './toolGate.js';
import type { ToolHookRunner } from './toolHookRunner.js';
import type { SessionRecorder } from './sessionRecorder.js';
import type { NativeToolRunner } from '../native/nativeBackend.js';
import type { ToolDiscovery } from '../search/toolDiscovery.js';
import type { ToolInputSink } from '../ports/tool/toolInputSink.js';
import type { SupervisorPort } from '../ports/runtime/supervisor.js';

/**
 * 单步运行依赖（全部来自端口）。
 *
 * 从 `stepRunner.ts` 抽出为独立类型文件：单步的三个协作者
 * （`StepRunner` / `StepContextBuilder` / `StepToolExecutor`）共用同一份依赖契约，
 * 放在此文件可避免三者之间出现「类型 import 成环」。
 * `stepRunner.ts` 仍以 `export type` 原样再导出，公共 API 面不变。
 */
export interface StepRunnerDeps {
  /** 模型端口（generate / 可选 stream）。 */
  readonly model: ModelPort;
  /** 工具端口（列举 + 执行）。 */
  readonly tools: ToolPort;
  /** 审批端口。 */
  readonly approvals: ApprovalPort;
  /** 沙箱端口。 */
  readonly sandbox: SandboxPort;
  /** 会话事件记录器（本步的输入投影与输出落盘都经它）。 */
  readonly recorder: SessionRecorder;
  /** 会话 id（透传给门禁与工具上下文）。 */
  readonly sessionId: string;
  /** 上下文压缩器（可选）：超预算时折叠较早历史。 */
  readonly compactor?: ContextCompactor | undefined;
  /** 额外常驻系统片段（可选）。 */
  readonly fragments?: readonly string[] | undefined;
  /** 工具钩子运行器（可选）：pre/post 拦截与审计。 */
  readonly hooks?: ToolHookRunner | undefined;
  /** 外溢器（#74）：超大工具输出入历史前先落后端，只留有界预览。 */
  readonly spiller?: ToolResultSpiller | undefined;
  /** 原生后端（FFI #66）：非空时工具执行路由到 Rust 内核 in-process；内核不可用由 createRuntime 置空以回退 JS。 */
  readonly native?: NativeToolRunner | undefined;
  /** 工具发现寄存器（#M1）：tool_search 命中后登记，使延迟加载工具后续回合对模型可见。 */
  readonly discovery?: ToolDiscovery | undefined;
  /** 升级审批端口（#G3/G4，可选）：运行时装配应注入 `runtime.escalation`。 */
  readonly escalation?: EscalationPort | undefined;
  /** 提权后的复核沙箱（#G3/G4，可选）：运行时装配应注入 `runtime.elevatedSandbox`。 */
  readonly elevatedSandbox?: SandboxPort | undefined;
  /**
   * 统一门禁（审批 + 沙箱 + 计划态）。不传则由 approvals/sandbox 造默认，
   * 但会丢失计划门禁——运行时装配应传入 `runtime.gate`（plan-aware）。
   */
  readonly gate?: ToolGate | undefined;
  /** 航天级监督内核（I-P0-3，可选）：工具执行成败上报此端口，驱动健康监控与 Safe mode 分级降级。 */
  readonly supervisor?: SupervisorPort | undefined;
  /**
   * 工具输入实时观察端口（#B3）：非空且模型支持 stream 时，模型流式生成的工具参数增量
   * 会实时转发到此端口供 UI 渐进渲染。缺失或模型不支持 stream 时退回 generate 路径，行为不变。
   */
  readonly live?: ToolInputSink | undefined;
  /** 提示注入护栏（opt-in）：为 true 时工具结果进上下文前做指令注入扫描并隔离命中项。 */
  readonly promptInjectionGuard?: boolean | undefined;
  /** 推理强度（#B6，可选）：透传为模型 reasoning_effort；缺省按模型默认。 */
  readonly reasoningEffort?: string | undefined;
  /**
   * 工作区根路径（U2）：非空时每步从当前查询推导 repo-map 上下文注入系统消息。
   * 配合 repoMapEnabled（默认开）使用；env OMNI_REPO_MAP=0 由装配层置 false 关闭。
   */
  readonly workspaceRoot?: string | undefined;
  /** repo-map 上下文注入开关（U2，默认开；传 false 即关）。 */
  readonly repoMapEnabled?: boolean | undefined;
  /**
   * repo-map 上下文引擎（P2.2 单例收敛）：组合根（memoryStackAssembler）构造、
   * 经 `ResolvedConfig` 注入；TTL 缓存状态随实例生命周期，不再有模块级单例。
   */
  readonly repoMapContext: RepoMapContextEngine;
  /**
   * 语义嵌入端口（U3 混合检索）：非空时 repo-map 走「BM25 ∪ 语义向量 RRF」混合路径，
   * 补词法盲区。默认不传 → 纯 BM25（零开销、不加载 80MB 模型）。
   * 仅在 env OMNI_SEMANTIC_RECALL=1 由 createRuntime 构造并注入；任何异常 fail-closed 回退 BM25。
   */
  readonly embedding?: EmbeddingPort | undefined;
  /**
   * 预算降级信号端口（P5 自动降档，可选）：非空且 `shouldDegrade` 为真时，本步 repo-map
   * 强制纯 BM25（忽略 embedding）并**收缩载荷大纲档位**（`payloadShape: 'degrade'`，只留
   * Top-1 完整大纲、其余降为路径行），直接压低 token 消耗。缺省 undefined
   * ⇒ 恒不降级，保持既有检索口径（零行为变更）。建模为端口是为守住 `core → adapters` 红线。
   */
  readonly budgetDegrade?: BudgetDegradeSignal | undefined;
  /**
   * 仓库常驻指令（AGENTS.md / CLAUDE.md / llms.txt）注入开关，默认开；传 false 即关。
   * 依赖 `workspaceRoot`：该值为空时无论开关如何都不注入。
   * 行业约定（6 万+ 仓库，Linux Foundation 治理），env OMNI_PROJECT_INSTRUCTIONS=0 由装配层置 false。
   */
  readonly projectInstructionsEnabled?: boolean | undefined;
  /**
   * 取消信号（V2，可选）：透传给模型请求（fetch 中断）。
   * 由 TurnRunner/Agent 层的 CancellationToken 派生并注入。
   */
  readonly signal?: AbortSignal | undefined;
  /**
   * 上下文窗口 token 数（可选，UI 容量面板的百分比分母）。
   *
   * 由组合根按 `ContextWindowCatalog`（env `OMNI_CONTEXT_WINDOW` → 厂商/模型表 → 缺省）
   * 解析后注入。缺省不传时快照仍产出（各类 token 数有效），仅「占窗口百分比」为未知。
   */
  readonly contextWindowTokens?: number | undefined;
}

/** 单步结果类型：产出了文本 / 发起了工具调用 / 空响应。 */
export type StepOutcome = 'text' | 'tool' | 'empty';
