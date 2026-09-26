import type { ApprovalPort } from '../../ports/runtime/approval.js';
import type { EventPort } from '../../ports/runtime/eventPort.js';
import type { ModelPort } from '../../ports/model/model.js';
import type { ResolvedConfig } from '../../config/configFactory.js';
import type { SkillRegistry } from '../../skill/skillRegistry.js';
import type { SupervisorPort } from '../../ports/runtime/supervisor.js';
import { Runtime } from '../../composition/runtime.js';
import { Agent } from '../../core/agent.js';
import { GraphStore } from '../../autonomy/graphStore.js';
import { type SubagentPortsShape, SubagentPorts } from '../../subagent/subagentPorts.js';

import { AUTO_ALLOW, DENY_ALL, RULES_DEFAULT } from './appServerState.js';
import { PlanApproval } from '../../adapters/approval/planApproval.js';
import { ServerNoopSupervisor } from './serverNoopSupervisor.js';

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
   * 是否应跳过生产级 SupervisorKernel：仅 `--auto-approve`（对应 UI「工具全部自动放行」）
   * 即跳过（用户已显式选「完全访问」即终局授权，fail-closed safe-mode 拦截写类工具与
   * 该授权矛盾）。上一版曾叠加 `sandbox.name === 'passthrough'`，但生产默认 sandbox 是
   * policySandbox（用户配置文件未显式设 sandbox），导致绕过条件不命中，supervisor
   * 仍拒写文件（2026-09-07 用户截图反馈）。其余配置保持原 SupervisorKernel 不动——本判断
   * 是服务端唯一放宽点，调用方只需把它当 supervisor 覆盖项传入 `createRuntime.create`。
   * @param config 已解析配置（当前实现仅占位，sandbox 类型由 ToolGate / 升级路径自行处理）
   * @returns 放宽用 no-op 监督内核；不满足条件时 undefined（保持生产内核）
   */
  public bypassSupervisorKernel(config: ResolvedConfig): SupervisorPort | undefined {
    // 用户终局授权判定：满足任一即视为「完全访问」，绕过 SupervisorKernel 的 fail-closed
    // 降级（safe/locked 会永久拦截 write_file/shell/apply_patch 等危险工具，与用户授权矛盾）。
    //   1) 启动标志 --auto-approve
    //   2) UI 权限档位 approval=auto（「完全访问 / 工具全部自动放行」，经 config.update 写入
    //      fieldOverrides.approval 并落盘；历史 bug：此处只看 autoApprove，导致用户在 UI 点
    //      「完全访问」后 supervisor 仍照常拦截——首个危险工具失败即翻 safe 永久封锁写类工具）。
    void config; // sandbox 类型由 ToolGate / 升级路径自行处理
    if (!this.deps.autoApprove() && this.deps.approvalOverride() !== 'auto') {
      return undefined;
    }
    return new ServerNoopSupervisor();
  }

  /**
   * 解析审批端口：上行 / 自动放行 / 配置端口三选一，并实时采纳 config.update 的 approval 覆盖。
   * 抽出来供 Agent 与图运行共用，避免两处审批逻辑漂移。
   * @param config 已解析配置（提供其 approvals 端口作默认）
   * @returns 生效的审批端口
   */
  public resolveApprovals(config: ResolvedConfig): ApprovalPort {
    const useUplink = this.deps.approvalUplink && !this.deps.autoApprove();
    let approvals: ApprovalPort = useUplink
      ? this.deps.uplink()
      : this.deps.autoApprove()
        ? AUTO_ALLOW
        : config.approvals;
    const override = this.deps.approvalOverride();
    if (override === 'auto') {
      approvals = AUTO_ALLOW;
    } else if (override === 'deny') {
      approvals = DENY_ALL;
    } else if (override === 'ask') {
      // 审批档：每次工具调用都经上行端口发 approval.request 等用户确认（UI 弹框）。
      approvals = this.deps.uplink();
    } else if (override === 'rules') {
      // 默认档：优先用启动时构建的 RuleApproval；若原配置是 auto/deny 被临时切过来，
      // 回退到内置默认 rules 端口，避免仍沿用旧的 AutoApproval/DenyAll。
      approvals = config.approvals.name === 'rules' ? config.approvals : RULES_DEFAULT;
    } else if (override === 'plan') {
      // 计划模式（UI「+ → 计划模式」）：只读白名单，写类工具一律 deny（fail-closed）。
      // 与 CLI `--approval plan` 同一实现，保证两条入口语义一致。
      approvals = new PlanApproval();
    }
    return approvals;
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
   * @returns 端口集（图运行审批固定 AUTO_ALLOW，见实现内注释）。
   */
  public graphPorts(): SubagentPortsShape {
    if (this.portsCache === undefined) {
      const config = this.deps.baseConfig();
      const serverConfig: ResolvedConfig = {
        ...config,
        events: this.deps.eventPort(),
        // 图运行是用户显式触发的「一键编排」：子步骤程序化执行，
        // 不应走交互式上行审批（否则 headless / 无人应答时永久挂死）。
        // 用户点击「运行」即视为已授权，固定 AUTO_ALLOW（与 CLI workflow 命令语义一致）。
        approvals: AUTO_ALLOW,
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
