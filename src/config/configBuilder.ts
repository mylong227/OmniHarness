import type { ApprovalPort } from '../ports/runtime/approval.js';
import type { EventPort } from '../ports/runtime/eventPort.js';
import type { ModelPort } from '../ports/model/model.js';
import { RetryingModel, DEFAULT_RETRY_POLICY } from '../adapters/model/retryingModel.js';
import { BudgetedModel } from '../adapters/model/budgetedModel.js';
import { CircuitBreakingModel } from '../adapters/model/circuitBreakingModel.js';
import { CircuitBreaker } from '../util/circuitBreaker.js';
import { CostBudget } from '../adapters/model/costBudget.js';
import { modelAdapterRegistry } from '../adapters/model/modelAdapterRegistry.js';
import {
  ModelRouter,
  type ModelRouterOptions,
  type RouterStrategy,
} from '../adapters/model/modelRouter.js';
import { ConfigError } from './configError.js';
import type { ModelRouterConfig } from './configFile.js';
import { endpointDefaults } from '../util/endpointDefaults.js';
import type { SandboxPort } from '../ports/runtime/sandbox.js';
import type { EscalationPort } from '../ports/runtime/escalation.js';
import { join } from 'node:path';
import type { SpillPort } from '../ports/memory/spill.js';
import { AutoApproval } from '../adapters/approval/autoApproval.js';
import { CachedApproval } from '../adapters/approval/cachedApproval.js';
import { TurnDiffTracker } from '../core/turnDiffTracker.js';
import { TurnDiffHooks } from '../adapters/diff/turnDiffHooks.js';
import { ToolHookRunner } from '../core/toolHookRunner.js';
import { FileSpill, DEFAULT_SPILL_MAX_FILES } from '../adapters/spill/fileSpill.js';
import { MemorySpill } from '../adapters/spill/memorySpill.js';
import type { LongTermMemoryPort } from '../ports/memory/longTermMemory.js';
import { ToolResultSpiller } from '../context/toolResultSpiller.js';
import { DEFAULT_GOAL_MAX_ITERATIONS } from '../autonomy/goalRunner.js';
import type { LspPort } from '../ports/tool/lsp.js';
import type { AgentIdentityPort } from '../ports/runtime/agentIdentity.js';
import { Ed25519AgentIdentity } from '../adapters/identity/ed25519AgentIdentity.js';
import { LspProcessAdapter } from '../adapters/lsp/lspProcessAdapter.js';
import { LspUri } from '../adapters/lsp/lspUri.js';
import type { UserResponder } from '../ports/runtime/userResponder.js';
import { ConsoleUserResponder } from '../adapters/user/consoleUserResponder.js';
import { DefaultUserResponder } from '../adapters/user/defaultUserResponder.js';
import type { OmniHarnessConfig, SubagentPortSeed } from './configFactory.js';

/** Spill 默认目录（#74：超大工具输出外溢，避免撑爆上下文）。 */
const DEFAULT_SPILL_DIR = '.omniharness/spill';

/**
 * 端口装配器（组合根一侧）：把 `OmniHarnessConfig` parts 收敛为具体端口实例。
 * 原模块级 builder 纯函数归拢为 `ConfigBuilder` 方法族；OOP 收口（2026-09-11）改为实例方法
 * 以消除 `static`，对外门面函数（同名）签名不变，调用点（runtime/Container）零改动。
 */
export class ConfigBuilder {
  /**
   * 装配审批端口（#M4）：未开启缓存时原样返回；开启则包一层 `CachedApproval`。
   * 策略指纹取「审批后端名 | 沙箱后端名」——任一侧策略变化即整体失效，
   * 避免沿用旧裁决（例如把 sandbox 从 policy 换成 restricted 后仍按旧结论放行）。
   * @param partial 用户配置（approvals / approvalCache）
   * @param sandbox 沙箱端口（policy 档位裁决依赖）
   * @returns 审批端口（可含缓存包装层）
   */
  public buildApprovals(partial: OmniHarnessConfig, sandbox: SandboxPort): ApprovalPort {
    const inner = partial.approvals ?? new AutoApproval();
    if (partial.approvalCache !== true) {
      return inner;
    }
    return new CachedApproval(inner, {
      cwd: partial.workspaceRoot,
      policyFingerprint: `${inner.name}|${sandbox.name}`,
      maxEntries: partial.approvalCacheMaxEntries,
    });
  }

  /** 装配工具钩子（#M5）：目前只有变更追踪钩子，后续钩子在此追加注册即可。 */
  public buildHooks(tracker: TurnDiffTracker, workspaceRoot: string): ToolHookRunner {
    const runner = new ToolHookRunner();
    runner.add(new TurnDiffHooks(tracker, workspaceRoot).hooks());
    return runner;
  }

  /**
   * 装配模型端口（#M6 + #S29 + F3）：
   * - 开启 `modelRetry` 则包 `RetryingModel` 退避重试（最内层，吸收单次调用的瞬时抖动）；
   * - 开启 `modelCircuitBreaker` 则在重试**外层**包 `CircuitBreakingModel`（一次逻辑调用 = 一次熔断计数）；
   * - 配置了 `costBudgetUsd` 正数则再包 `BudgetedModel`（最外层，先判预算再重试/熔断，确保不重复记账、
   *   预算硬门禁优先于一切）。
   * 三者皆可选，对上层透明（名称/接口不变）。最终顺序：`Budgeted(Circuit(Retrying(inner)))`。
   */
  public buildModel(partial: OmniHarnessConfig, budget: CostBudget | undefined): ModelPort {
    let inner: ModelPort;
    if (partial.modelRouter !== undefined) {
      inner = this.buildRouter(partial.modelRouter);
    } else {
      inner = partial.model;
    }
    if (partial.modelRetry === true) {
      inner = new RetryingModel(inner, {
        maxAttempts: partial.modelRetryMaxAttempts ?? DEFAULT_RETRY_POLICY.maxAttempts,
        baseDelayMs: partial.modelRetryBaseDelayMs ?? DEFAULT_RETRY_POLICY.baseDelayMs,
        maxDelayMs: DEFAULT_RETRY_POLICY.maxDelayMs,
        jitter: DEFAULT_RETRY_POLICY.jitter,
      });
    }
    if (partial.modelCircuitBreaker === true) {
      inner = new CircuitBreakingModel(
        inner,
        new CircuitBreaker('model', {
          failureThreshold: partial.modelCircuitBreakerThreshold,
          openMs: partial.modelCircuitBreakerOpenMs,
        }),
      );
    }
    if (budget !== undefined && budget.limitUsd > 0) {
      inner = new BudgetedModel(inner, budget);
    }
    return inner;
  }

  /**
   * 装配模型路由（#B4）：按 modelRouter 配置把多个底层适配器包成单一 ModelRouter。
   * entries 的 adapter 复用既有模型适配器构造逻辑（按 adapter 类型名选底层适配器，默认 mock），
   * 凭据取自环境变量（与 CLI 一致，fail-closed 缺密钥即报错）。
   */
  public buildRouter(cfg: ModelRouterConfig): ModelPort {
    const VALID_STRATEGIES = new Set<string>([
      'least-cost',
      'round-robin',
      'by-task',
      'health-fallback',
    ]);
    if (!VALID_STRATEGIES.has(cfg.strategy)) {
      throw new ConfigError(
        `modelRouter.strategy 取值 "${cfg.strategy}" 非法，允许: ${[...VALID_STRATEGIES].join(' | ')}`,
      );
    }
    if (cfg.entries.length === 0) {
      throw new ConfigError('modelRouter.entries 不能为空（fail-closed）');
    }
    const entries: ModelRouterOptions['entries'] = cfg.entries.map((entry) => ({
      adapter: this.buildRouterAdapter(entry),
      model: entry.model,
      pricing: entry.pricing,
    }));
    return new ModelRouter({
      entries,
      strategy: cfg.strategy as RouterStrategy,
      taskField: cfg.taskField,
    });
  }

  /**
   * 按 adapter 类型名构造底层模型适配器（**走一张表**：`adapters/model/modelAdapterRegistry.ts`；
   * 凭据取环境变量，fail-closed）。
   *
   * 端点的兜底值来自 `defaults/endpoints.json`（用户指令：地址不硬编码）。此前本方法自带一份
   * `if (type === 'openai') …` 分支，与 `cliBuildConfig.buildModel`、
   * `providerProbe.buildModelForProvider` 各写一遍（审计 §3.4「改一处漏一处」）——
   * 现构造只在注册表里，本方法只做「查表 + 取兜底 + 组装」。
   * @param entry modelRouter 的条目（含模型名与可选适配器类型）。
   * @returns 对应的模型端口。
   * @throws ConfigError 适配器类型未知，或必需的环境变量缺失时抛出。
   */
  public buildRouterAdapter(entry: ModelRouterConfig['entries'][number]): ModelPort {
    const type = entry.adapter ?? 'mock';
    const spec = modelAdapterRegistry.get(type);
    if (spec === undefined) {
      throw new ConfigError(`modelRouter 未知 adapter 类型 "${type}"`);
    }
    if (spec.defaultsId === undefined) {
      return spec.create({ baseUrl: '', model: entry.model }); // mock：无端点、无凭据
    }
    const defaults = endpointDefaults.resolveAdapter(spec.defaultsId);
    if (defaults === undefined) {
      throw new ConfigError(`modelRouter 的 adapter "${type}" 未登记于 defaults/endpoints.json`);
    }
    if (defaults.requiresApiKey && defaults.apiKey === undefined) {
      throw new ConfigError(
        `modelRouter ${type} 条目需要环境变量 ${defaults.apiKeyEnv ?? '(未声明)'}`,
      );
    }
    return spec.create({
      baseUrl: defaults.baseUrl,
      model: entry.model,
      ...(defaults.apiKey === undefined ? {} : { apiKey: defaults.apiKey }),
    });
  }

  /**
   * 装配 LSP 端口（#S32）：仅当配置了 `lsp.serverCommand` 时构造 `LspProcessAdapter`（外启语言服务器子进程）。
   * 服务器由用户自备——这是零依赖铁律下接入 LSP 的唯一合规方式；不配则端口为 undefined，LSP 工具不注册。
   * rootUri 缺省用 workspaceRoot 推导的 file:// URI。
   */
  public buildLsp(partial: OmniHarnessConfig): LspPort | undefined {
    if (partial.lspServer === undefined || partial.lspServer.serverCommand.trim() === '') {
      return undefined;
    }
    return new LspProcessAdapter({
      serverCommand: partial.lspServer.serverCommand,
      serverArgs: partial.lspServer.serverArgs,
      rootUri: partial.lspServer.rootUri ?? LspUri.fileToUri(partial.workspaceRoot),
    });
  }

  /**
   * 装配 Agent 密码学身份端口（#S33）：仅当配置了 `agentIdentity`（私钥或 runtimeId）时构造 `Ed25519AgentIdentity`。
   * 零依赖（仅 Node 内置 node:crypto）。不配则端口为 undefined，`agent_identity` 工具不注册。
   */
  public buildIdentity(partial: OmniHarnessConfig): AgentIdentityPort | undefined {
    if (partial.agentIdentity === undefined) {
      return undefined;
    }
    return new Ed25519AgentIdentity({
      privateKeyPkcs8Base64: partial.agentIdentity.privateKeyPkcs8Base64,
      agentRuntimeId: partial.agentIdentity.agentRuntimeId,
    });
  }

  /** 自动选择用户回答器：TTY 交互用 Console，否则 fail-soft 的 Default。 */
  public autoUserResponder(): UserResponder {
    return process.stdout.isTTY ? new ConsoleUserResponder() : new DefaultUserResponder();
  }

  /**
   * 构造子智能体端口种子：`tools` 字段留空，由 `defaultTools` 回填为正在构造的注册表——
   * 子代工具子集需从父工具集裁剪，故此处存在构造期循环引用（运行时解引用，无害）。
   */
  public seedOf(
    partial: OmniHarnessConfig,
    approvals: ApprovalPort,
    sandbox: SandboxPort,
    events: EventPort,
    spill: SpillPort,
    spiller: ToolResultSpiller,
    escalation: EscalationPort,
    elevatedSandbox: SandboxPort,
    longTermMemory: LongTermMemoryPort,
    costBudget: CostBudget | undefined,
  ): SubagentPortSeed {
    return {
      model: this.buildModel(partial, costBudget),
      storage: partial.storage,
      events,
      sandbox,
      approvals,
      spill,
      spiller,
      workspaceRoot: partial.workspaceRoot,
      maxSteps: partial.maxSteps,
      escalation,
      elevatedSandbox,
      longTermMemory,
      goalMaxIterations: partial.goalMaxIterations ?? DEFAULT_GOAL_MAX_ITERATIONS,
      subagent: {
        maxDepth: partial.subagentMaxDepth,
        maxConcurrency: partial.subagentConcurrency,
        maxSteps: partial.subagentMaxSteps,
      },
    };
  }

  /** 构建外溢端口：自定义优先，否则按 spillAdapter 选内置实现。 */
  public buildSpill(partial: OmniHarnessConfig): SpillPort {
    if (partial.spill !== undefined) {
      return partial.spill;
    }
    if (partial.spillAdapter === 'memory') {
      return new MemorySpill();
    }
    return new FileSpill(join(partial.workspaceRoot, partial.spillDir ?? DEFAULT_SPILL_DIR), {
      maxFiles: partial.spillMaxFiles ?? DEFAULT_SPILL_MAX_FILES,
    });
  }

  /** 装配审批端口（门面：委托默认装配器实例）。 */
  public static buildApprovals(partial: OmniHarnessConfig, sandbox: SandboxPort): ApprovalPort {
    return configBuilder.buildApprovals(partial, sandbox);
  }

  /** 装配工具钩子（门面：委托默认装配器实例）。 */
  public static buildHooks(tracker: TurnDiffTracker, workspaceRoot: string): ToolHookRunner {
    return configBuilder.buildHooks(tracker, workspaceRoot);
  }

  /** 装配模型端口（门面：委托默认装配器实例）。 */
  public static buildModel(partial: OmniHarnessConfig, budget: CostBudget | undefined): ModelPort {
    return configBuilder.buildModel(partial, budget);
  }

  /** 装配模型路由（门面：委托默认装配器实例）。 */
  public static buildRouter(cfg: ModelRouterConfig): ModelPort {
    return configBuilder.buildRouter(cfg);
  }

  /** 按 adapter 类型名构造底层模型适配器（门面：委托默认装配器实例）。 */
  public static buildRouterAdapter(entry: ModelRouterConfig['entries'][number]): ModelPort {
    return configBuilder.buildRouterAdapter(entry);
  }

  /** 装配 LSP 端口（门面：委托默认装配器实例）。 */
  public static buildLsp(partial: OmniHarnessConfig): LspPort | undefined {
    return configBuilder.buildLsp(partial);
  }

  /** 装配 Agent 密码学身份端口（门面：委托默认装配器实例）。 */
  public static buildIdentity(partial: OmniHarnessConfig): AgentIdentityPort | undefined {
    return configBuilder.buildIdentity(partial);
  }

  /** 自动选择用户回答器（门面：委托默认装配器实例）。 */
  public static autoUserResponder(): UserResponder {
    return configBuilder.autoUserResponder();
  }

  /** 构造子智能体端口种子（门面：委托默认装配器实例）。 */
  public static seedOf(
    partial: OmniHarnessConfig,
    approvals: ApprovalPort,
    sandbox: SandboxPort,
    events: EventPort,
    spill: SpillPort,
    spiller: ToolResultSpiller,
    escalation: EscalationPort,
    elevatedSandbox: SandboxPort,
    longTermMemory: LongTermMemoryPort,
    costBudget: CostBudget | undefined,
  ): SubagentPortSeed {
    return configBuilder.seedOf(
      partial,
      approvals,
      sandbox,
      events,
      spill,
      spiller,
      escalation,
      elevatedSandbox,
      longTermMemory,
      costBudget,
    );
  }

  /** 构建外溢端口（门面：委托默认装配器实例）。 */
  public static buildSpill(partial: OmniHarnessConfig): SpillPort {
    return configBuilder.buildSpill(partial);
  }
}

// ---- 门面兼容：保留原函数名（同名函数），调用点零改动 ----
const configBuilder = new ConfigBuilder();
