import type { ApprovalPort } from '../ports/approval.js';
import type { EventPort } from '../ports/eventPort.js';
import type { ModelPort } from '../ports/model.js';
import type { ResolvedConfig } from '../config/omniharnessConfig.js';
import type { SkillRegistry } from '../skill/skillRegistry.js';
import type { SupervisorPort } from '../ports/supervisor.js';
import { createRuntime } from '../core/runtime.js';
import { Agent } from '../core/agent.js';
import { GraphStore } from '../autonomy/graphStore.js';
import { portsOf, type SubagentPorts } from '../subagent/subagentPorts.js';
import { AUTO_ALLOW, DENY_ALL, RULES_DEFAULT } from './appServerState.js';
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
  private readonly deps: AgentRuntimeDeps;
  private agentCache?: Agent;
  private storeCache?: GraphStore;
  private portsCache?: SubagentPorts;

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
    }
    return approvals;
  }

  /** 构建 Agent（覆盖事件端口；审批按需上行；UI 覆盖的模型配置实时生效）。 */
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
        createRuntime(
          supervisor !== undefined ? { ...serverConfig, supervisor } : serverConfig,
        ),
        this.deps.skills,
      );
    }
    return this.agentCache;
  }

  /** 失效 Agent 缓存（配置变更 / 切换工作区后下回合重建）。 */
  public invalidateAgent(): void {
    this.agentCache = undefined;
  }

  /** 懒初始化图存储（工作区 .omniharness/graphs）。 */
  public graphStore(): GraphStore {
    if (this.storeCache === undefined) {
      this.storeCache = new GraphStore(this.deps.workspaceRoot());
    }
    return this.storeCache;
  }

  /** 懒初始化子智能体端口集（供图运行复用同一运行时能力）。 */
  public graphPorts(): SubagentPorts {
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
      this.portsCache = portsOf(
        createRuntime(
          supervisor !== undefined ? { ...serverConfig, supervisor } : serverConfig,
        ),
      );
    }
    return this.portsCache;
  }

  /** 失效图存储与端口缓存（切换工作区后按新根重建）。 */
  public invalidateGraph(): void {
    this.storeCache = undefined;
    this.portsCache = undefined;
  }
}
