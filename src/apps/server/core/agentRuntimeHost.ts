import type { ApprovalPort } from '../../../contracts/ports/runtime/approval.ts';
import type { EventPort } from '../../../contracts/ports/runtime/eventPort.ts';
import type { ModelPort } from '../../../contracts/ports/model/model.ts';

import type { SkillRegistry } from '../../../kernel/skill/skillRegistry.ts';
import type { SupervisorPort } from '../../../contracts/ports/runtime/supervisor.ts';
import { Runtime } from '../../composition/runtime.ts';
import { Agent } from '../../../kernel/core/agent.ts';
import { GraphStore } from '../../../kernel/autonomy/graphStore.ts';
import { SubagentPorts } from '../../../kernel/subagent/subagentPorts.ts';

import { AUTO_ALLOW, DENY_ALL, RULES_DEFAULT } from './appServerState.ts';
import { PlanApproval } from '../../../kernel/adapters/approval/planApproval.ts';
import { AskApproval } from '../../../kernel/adapters/approval/askApproval.ts';
import { ServerNoopSupervisor } from './serverNoopSupervisor.ts';
import type { ResolvedConfig } from '../../../contracts/ports/config/resolvedConfig.ts';
import type { SubagentPortsShape } from '../../../contracts/ports/subagent/subagentPortsShape.ts';

/** Agent/图运行时宿主依赖。 */
export interface AgentRuntimeDeps {
  /** 基础解析配置（切换工作区后会被替换，故用 getter 实时读取）。 */
  readonly baseConfig: () => ResolvedConfig;
  /** 技能注册表。 */
  readonly skills: SkillRegistry | undefined;
  /** 事件端口工厂（每次构造运行时取一个）。 */
  readonly eventPort: () => EventPort;
  /** 是否开启审批上行（--approval-uplink）。 */
  readonly approvalUplink: boolean;
  /** 启动标志 --auto-approve（UI 可经 config.update 切换，故用 getter）。 */
  readonly autoApprove: () => boolean;
  /** UI 覆盖的审批档位（无覆盖时 undefined）。 */
  readonly approvalOverride: () => string | undefined;
  /**
   * 启动档位（组合根按分层配置解析出的 `args.approval`；缺省 undefined）。
   *
   * 为什么必须有它：UI 切档经 config.update **持久化**到用户级 omniharness.json，
   * 而内存覆盖态重启即空。只看内存覆盖时，重启后生效端口回退到启动时构建的
   * `config.approvals`——`approval: 'ask'` 落盘后重启会静默变回启动端口（历史上是
   * AutoApproval 全放行），界面却仍显示「请求批准」。「档位切换不生效」类缺陷的根因即此。
   */
  readonly configuredApproval: () => string | undefined;
  /** 审批上行端口工厂。 */
  readonly uplink: () => ApprovalPort;
  /** UI 覆盖的运行时模型（无覆盖时 undefined）。 */
  readonly modelOverride: () => ModelPort | undefined;
  /** 当前生效工作区根（图存储位置用）。 */
  readonly workspaceRoot: () => string;
}

/**
 * Agent 与图运行时宿主：负责运行时装配（Agent / 图端口集）、审批端口解析与
 * SupervisorKernel 放宽判定，并持有三者缓存（切换工作区或配置变更时统一失效）。
 *
 * 组合优于继承：本类不感知 RPC/handlers，只对「如何按配置造出一个运行时」负责，
 * 因此可独立单测。`bypassSupervisorKernel` 是服务端唯一放宽点，语义详见其注释。
 */
export class AgentRuntimeHost {
  /** 宿主依赖（配置 / 事件 / 审批工厂与工作区根，全部为实时取值器）。 */
  private readonly deps: AgentRuntimeDeps;
  /** Agent 缓存（invalidateAgent 失效）。 */
  private agentCache?: Agent | undefined;
  /**
   * 已被缓存失效但仍可能有在跑回合的 Agent（用于「停止」不失效）。
   *
   * 存在理由（2026-09-26 审计 S4，P1「Stop 静默失效」）：`config.update` / 切换工作区会
   * `invalidateAgent()`，而 `turns.abort` 走的是 `this.runtime.agent()` —— 它会**新建**一个
   * Agent（`runningSessions` 为空），于是取消令牌找不到在跑的会话，停止按钮变成空操作，
   * 原回合继续跑到完成。故失效时把旧实例留在退役表里，取消时一并尝试。
   * 上限 4：足够覆盖「切换几次配置后仍有一个长回合在跑」的现实场景，且不至于无限持有。
   */
  private readonly retiredAgents: Agent[] = [];

  /** 退役表上限（超出即淘汰最旧，运行中回合的窗口足够覆盖）。 */
  private static readonly MAX_RETIRED_AGENTS = 4;
  /** 图存储缓存（按工作区根懒建，invalidateGraph 失效）。 */
  private storeCache?: GraphStore | undefined;
  /** 子智能体端口集缓存（图运行复用）。 */
  private portsCache?: SubagentPortsShape | undefined;

  /**
   * @param deps 配置来源、事件/审批工厂与工作区根
   */
  public constructor(deps: AgentRuntimeDeps) {
    this.deps = deps;
  }

  /**
   * 生效审批档位（唯一裁决入口，`resolveApprovals` / `bypassSupervisorKernel` 共用）。
   *
   * 优先级（高 → 低）：
   *  1. **内存覆盖**（UI 本次运行内切档，`config.update` 写入）——最 explicit、也最新；
   *  2. **autoApprove 运行态开关**（`--auto-approve` 或审批弹框里点了「总是允许」）——
   *     语义是「此后不再问」，必须压过落盘档位，否则点完「总是允许」下一回合又弹框；
   *  3. **落盘档位**（用户级 omniharness.json 的 `approval`，UI 切档的持久化形态）——
   *     重启后由它保证「界面显示哪档、实际就是哪档」。
   *
   * @returns 生效档位枚举值；三者皆无时 undefined（维持启动语义）。
   */
  private effectiveApproval(): string | undefined {
    return (
      this.deps.approvalOverride() ??
      (this.deps.autoApprove() ? 'auto' : this.deps.configuredApproval())
    );
  }

  /**
   * 是否应跳过生产级 SupervisorKernel：仅「完全访问」档（`--auto-approve` 或生效档位 auto）
   * 即跳过（用户已显式选「完全访问」即终局授权，fail-closed safe-mode 拦截写类工具与
   * 该授权矛盾）。上一版曾叠加 `sandbox.name === 'passthrough'`，但生产默认 sandbox 是
   * policySandbox（用户配置文件未显式设 sandbox），导致绕过条件不命中，supervisor
   * 仍拒写文件（2026-09-07 用户截图反馈）。其余配置保持原 SupervisorKernel 不动——本判断
   * 是服务端唯一放宽点，调用方只需把它当 supervisor 覆盖项传入 `createRuntime.create`。
   *
   * 生效档位经 {@link effectiveApproval} 取——**落盘的 auto 也算数**（历史 bug：此处只看
   * 内存覆盖与启动标志，UI 选「完全访问」→ 落盘 → 重启后覆盖态清空，supervisor 重新
   * fail-closed，「完全访问」档静默降级）。
   * @param config 已解析配置（当前实现仅占位，sandbox 类型由 ToolGate / 升级路径自行处理）
   * @returns 放宽用 no-op 监督内核；不满足条件时 undefined（保持生产内核）
   */
  public bypassSupervisorKernel(config: ResolvedConfig): SupervisorPort | undefined {
    // sandbox 类型由 ToolGate / 升级路径自行处理
    void config;
    if (this.effectiveApproval() !== 'auto') {
      return undefined;
    }
    return new ServerNoopSupervisor();
  }

  /**
   * 解析审批端口：按生效档位裁决，并实时采纳 config.update 的档位切换。
   * 抽出来供 Agent 与图运行共用，避免两处审批逻辑漂移。
   *
   * 档位 → 端口对应（与 `ApprovalTierCatalog` 的五档一一对应，缺一即「切档不生效」）：
   *  - `auto`  → AUTO_ALLOW（完全访问）；
   *  - `deny`  → DENY_ALL（全部拒绝）；
   *  - `ask`   → AskApproval，询问回调走上行弹框（请求批准：本地只读自动放行，
   *              编辑/联网/命令逐次弹框——与档位描述「编辑外部文件和使用互联网时始终询问」一致）；
   *  - `plan`  → PlanApproval 只读白名单（计划模式）；
   *  - `rules` → 配置端口本身是 rules（或落盘值就是 rules，含 approvalCache 包装形态）则沿用，
   *              否则回退 `RULES_DEFAULT`（真规则审批：rm/del 拒绝，其余放行）。
   * @param config 已解析配置（提供其 approvals 端口作默认）
   * @returns 生效的审批端口
   */
  public resolveApprovals(config: ResolvedConfig): ApprovalPort {
    const tier = this.effectiveApproval();
    if (tier === 'auto') {
      return AUTO_ALLOW;
    }
    if (tier === 'deny') {
      return DENY_ALL;
    }
    if (tier === 'ask') {
      // 审批档：本地只读放行，其余经上行端口发 approval.request 等用户确认（UI 弹框）。
      return new AskApproval({ askHandler: (request) => this.deps.uplink().decide(request) });
    }
    if (tier === 'plan') {
      // 计划模式（UI「+ → 计划模式」）：只读白名单，写类工具一律 deny（fail-closed）。
      // 与 CLI `--approval plan` 同一实现，保证两条入口语义一致。
      return new PlanApproval();
    }
    if (tier === 'rules') {
      // 默认档：优先沿用启动时按 rules 构建的配置端口（保留自定义 permission.rules 与
      // approvalCache 包装）；配置端口明显不是 rules（auto/deny/plan 等被临时切过来）时，
      // 回退到与启动路径同规则的内置默认端口，绝不沿用旧的 AutoApproval/DenyAll。
      const configuredIsRules =
        config.approvals.name === 'rules' || this.deps.configuredApproval() === 'rules';
      return configuredIsRules ? config.approvals : RULES_DEFAULT;
    }
    // 无任何档位值（或 CLI 专属的 guardian 策略）：维持启动语义——上行开关 / autoApprove /
    // 配置端口，与既有行为逐字一致。
    const useUplink = this.deps.approvalUplink && !this.deps.autoApprove();
    return useUplink ? this.deps.uplink() : config.approvals;
  }

  /**
   * 构建 Agent（覆盖事件端口；审批按需上行；UI 覆盖的模型配置实时生效）。
   * @returns 缓存的 Agent 实例（首次调用时按当前配置装配）。
   */
  public agent(): Agent {
    if (this.agentCache === undefined) {
      const config = this.deps.baseConfig();
      const modelOverride = this.deps.modelOverride();
      const serverConfig: ResolvedConfig = {
        ...config,
        ...(modelOverride !== undefined ? { model: modelOverride } : {}),
        events: this.deps.eventPort(),
        approvals: this.resolveApprovals(config),
      };
      const supervisor = this.bypassSupervisorKernel(serverConfig);
      this.agentCache = new Agent(
        Runtime.createRuntime(
          supervisor !== undefined ? { ...serverConfig, supervisor } : serverConfig,
        ),
        this.deps.skills,
      );
    }
    return this.agentCache;
  }

  /**
   * 失效 Agent 缓存（配置变更 / 切换工作区后下回合重建）。
   *
   * 旧实例进入**退役表**而不是直接丢弃：它可能仍有在跑回合，`turns.abort` 必须还能找到它的取消
   * 令牌（见 {@link AgentRuntimeHost.cancelAll}）。
   * @returns 无返回值。
   */
  public invalidateAgent(): void {
    if (this.agentCache !== undefined) {
      this.retiredAgents.push(this.agentCache);
      while (this.retiredAgents.length > AgentRuntimeHost.MAX_RETIRED_AGENTS) {
        this.retiredAgents.shift();
      }
    }
    this.agentCache = undefined;
  }

  /**
   * 取消在跑回合：**当前 Agent ∪ 全部退役 Agent**。
   *
   * 为什么必须覆盖退役实例（2026-09-26 审计 S4）：`config.update` / 切换工作区只清缓存，
   * 若取消只打当前缓存实例，则「配置改过一次之后停止按钮就是死的」—— 用户在 UI 上点了停止，
   * 回合却继续跑完。返回被触及的实例数，供调用方与测试观测。
   * @param reason 取消原因（透传取消令牌，用于事件与错误文案）。
   * @param sessionId 目标会话 id；缺省表示取消全部在跑会话。
   * @returns 实际被尝试取消的 Agent 实例数（含当前与退役）。
   */
  public cancelAll(reason: 'user' | 'timeout' | 'shutdown', sessionId?: string): number {
    let touched = 0;
    const targets = [
      ...(this.agentCache !== undefined ? [this.agentCache] : []),
      ...this.retiredAgents,
    ];
    for (const agent of targets) {
      agent.cancelCurrentRun(reason, sessionId);
      touched += 1;
    }
    return touched;
  }

  /**
   * 懒初始化图存储（工作区 .omniharness/graphs）。
   * @returns 当前工作区的 GraphStore 实例（缓存复用）。
   */
  public graphStore(): GraphStore {
    if (this.storeCache === undefined) {
      this.storeCache = new GraphStore(this.deps.workspaceRoot());
    }
    return this.storeCache;
  }

  /**
   * 懒初始化子智能体端口集（供图运行复用同一运行时能力）。
   * @returns 端口集（图运行审批按**生效档位**解析，见实现内注释）。
   */
  public graphPorts(): SubagentPortsShape {
    if (this.portsCache === undefined) {
      const config = this.deps.baseConfig();
      const serverConfig: ResolvedConfig = {
        ...config,
        events: this.deps.eventPort(),
        // 图运行的审批与普通回合同一档位裁决（resolveApprovals）：「完全访问」放行一切、
        // 「全部拒绝」一个工具都不跑。历史实现固定 AUTO_ALLOW，用户切到 deny 档后图运行
        // 照样产生副作用——正是「切档不生效」的又一条通路。
        // 「点击运行即视为已授权」的旧口径只在 auto 档下成立；无人值守场景（ask 档弹框
        // 无人应答）由上行审批的超时 deny 兜底，不会永久挂死。
        approvals: this.resolveApprovals(config),
      };
      const supervisor = this.bypassSupervisorKernel(serverConfig);
      this.portsCache = SubagentPorts.portsOf(
        Runtime.createRuntime(
          supervisor !== undefined ? { ...serverConfig, supervisor } : serverConfig,
        ),
      );
    }
    return this.portsCache;
  }

  /**
   * 失效图存储与端口缓存（切换工作区后按新根重建）。
   * @returns 无返回值。
   */
  public invalidateGraph(): void {
    this.storeCache = undefined;
    this.portsCache = undefined;
  }
}
