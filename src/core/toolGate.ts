import type { ApprovalPort } from '../ports/runtime/approval.js';
import type { SupervisorPort } from '../ports/runtime/supervisor.js';
import type { SandboxAction, SandboxDecision, SandboxPort } from '../ports/runtime/sandbox.js';
/**
 * 提权沙箱默认 fail-closed：未显式注入 elevatedSandbox 时一律拒绝升级，绝不静默全放行
 * （防御性兜底，防止手动/测试构造 ToolGate 漏注入时把提权重试变成沙箱绕过）。
 * 此前由 adapters/sandbox/UnsupportedSandbox 提供，现内联以保持 core 层零适配器依赖。
 */
const FAIL_CLOSED_ELEVATED_SANDBOX: SandboxPort = {
  name: 'elevated-fail-closed',
  async check(_action: SandboxAction): Promise<SandboxDecision> {
    return {
      allowed: false,
      reason: '平台不支持的沙箱后端: 提权沙箱未注入，默认 fail-closed 拒绝升级',
      category: 'os',
    };
  },
};
import type { PlanPort } from '../ports/runtime/plan.js';
import type { ToolCall, ToolResult } from '../ports/tool/tool.js';
import type { EscalationPort } from '../ports/runtime/escalation.js';

/**
 * @beta
 * 计划模式下被门禁拦截的"写类"工具（探索/提问/计划类工具不在其列）。
 */
export const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  'shell',
  // 交互式 PTY 工具：能在真终端里跑任意命令（vim/htop 等）⇒ 与 shell 同级，plan 模式同样拦截。
  'shell_interactive',
  // 后台作业管理（P2-⑫）：能 kill 进程、能启动任意命令 ⇒ 与 shell 同级，plan 模式同样拦截。
  'shell_job',
  'write_file',
  'edit',
  'apply_patch',
  'delegate',
  'subagent',
  // P2-⑬：网页截图落盘 PNG，与 write_file 同级（plan 模式须拦截）。
  'browser_screenshot',
]);

/**
 * @beta
 * 工具门禁：审批 + 沙箱 + 计划态三道门禁统一裁决（fail-closed，任意拒绝即拦截）。
 */
export class ToolGate {
  public constructor(
    /** 审批端口：策略层裁决（auto/rules/plan 白名单），deny 不升级直接拒绝。 */
    private readonly approvals: ApprovalPort,
    /** 基础沙箱端口：OS 层能力裁决（文件读/写/命令）。 */
    private readonly sandbox: SandboxPort,
    /** 计划端口（可选）：plan mode 读取计划状态做写类拦截。 */
    private readonly plan?: PlanPort,
    /** 是否处于计划模式：开启时写类工具在计划获批前一律拦截。 */
    private readonly planMode = false,
    /** 升级审批端口（#G3/G4）：仅沙箱拒绝时咨询；审批策略拒绝不升级，避免绕过既定策略。 */
    private readonly escalation?: EscalationPort,
    /** 提权后的复核沙箱（默认 fail-closed：未显式注入时一律拒绝升级，绝不静默全放行。
     *  ConfigFactory 实际注入 PolicySandbox 做收紧；本默认仅为防御性兜底，
     *  防止任何手动构造 ToolGate 漏注入 elevatedSandbox 时把提权重试变成沙箱绕过）。 */
    private readonly elevatedSandbox: SandboxPort = FAIL_CLOSED_ELEVATED_SANDBOX,
    /** 航天级监督内核（I-P0-3，可选）：最高优先级确定性否决，置于审批/沙箱/计划门禁之前。 */
    private readonly supervisor?: SupervisorPort,
  ) {}

  /**
   * 门禁检查：通过返回 undefined，否则返回带具体原因的拒绝结果（可观测性 #OBS-1：plan/审批/沙箱各自的真实拒绝原因透传，便于 UI/日志归因）。
   * @param call 待裁决的工具调用（名称 + 入参）。
   * @param sessionId 发起调用的会话 ID（审批/升级审批需要）。
   * @returns 拒绝时为带原因的失败 ToolResult；放行时为 undefined。
   */
  public async gate(call: ToolCall, sessionId: string): Promise<ToolResult | undefined> {
    // 监督内核：确定性否决，优先级高于审批/沙箱/计划门禁（ML 层置于确定性否决之下）。
    if (this.supervisor !== undefined) {
      const verdict = this.supervisor.intercept(call.name);
      if (verdict !== undefined) {
        return { callId: call.id, ok: false, error: verdict };
      }
    }
    const denialReason = await this.denialReason(call, sessionId);
    if (denialReason !== undefined) {
      return { callId: call.id, ok: false, error: denialReason };
    }
    return undefined;
  }

  /**
   * 取具体拒绝原因；未拒绝返回 undefined。区分 plan / 审批 / 沙箱三类，便于 UI 归因（G3 可观测性）。
   * @param call 待裁决的工具调用。
   * @param sessionId 发起调用的会话 ID。
   * @returns 拒绝原因文本（含门禁类别）；三道门禁全部放行时为 undefined。
   */
  private async denialReason(call: ToolCall, sessionId: string): Promise<string | undefined> {
    // 计划门禁（最先判：未批准前禁止任何写类工具，哪怕审批/沙箱放行）。
    if (this.planMode && this.plan !== undefined && MUTATING_TOOLS.has(call.name)) {
      const state = this.plan.get();
      if (state === null) {
        return `plan mode 未提交计划：写类工具（${call.name}）需先 plan_write 提交计划并 plan_present 经用户批准后才能执行`;
      }
      if (state.status !== 'approved') {
        return `plan mode 未批准：当前计划状态=${state.status}，写类工具（${call.name}）需经用户批准后才能执行`;
      }
    }
    const approval = await this.approvals.decide({
      sessionId,
      toolName: call.name,
      target: this.targetOf(call),
    });
    if (approval === 'deny') {
      // 审批策略拒绝：不升级（升级会绕过既定策略，违反最小权限）。
      const policyName = this.approvals.name ?? 'approval';
      return `${policyName} 策略拒绝（${call.name}）：当前审批模式不允许该工具（plan mode 仅放行只读白名单；rules 模式按规则裁决；如需放行请切换 approval=auto 或加 --auto-approve）`;
    }
    const decision = await this.sandbox.check(this.sandboxActionOf(call));
    if (decision.allowed) {
      return undefined;
    }
    // G3/G4 核心：沙箱拒绝 → 咨询升级审批，escalate 且 elevatedSandbox 放行则放行。
    if (await this.tryEscalate(call, sessionId, decision)) {
      return undefined;
    }
    const cat = decision.category ? `[${decision.category}] ` : '';
    const tgt = this.targetOf(call);
    return `sandbox 拒绝（${call.name}：${tgt}）${cat}${decision.reason ?? '未提供原因'}`;
  }

  /**
   * 沙箱拒绝后的升级尝试：escalate 且提权沙箱放行则返回 true（放行），否则保持拒绝。
   * @param call 被基础沙箱拒绝的工具调用。
   * @param sessionId 发起调用的会话 ID。
   * @param decision 基础沙箱的拒绝决定（原因透传给升级审批）。
   * @returns 升级获批且提权沙箱放行时为 true；否则 false（维持拒绝）。
   */
  private async tryEscalate(
    call: ToolCall,
    sessionId: string,
    decision: SandboxDecision,
  ): Promise<boolean> {
    if (this.escalation === undefined) {
      return false;
    }
    const verdict = await this.escalation.decide({
      sessionId,
      toolName: call.name,
      target: this.targetOf(call),
      reason: decision.reason ?? 'sandbox denied',
      deniedBy: 'sandbox',
    });
    if (verdict !== 'escalate') {
      return false;
    }
    const elevated = await this.elevatedSandbox.check(this.sandboxActionOf(call));
    return elevated.allowed;
  }

  /**
   * 按工具类型映射沙箱动作（命令/读/写）。
   * @param call 工具调用（按名称归类到 file_read/file_write/command）。
   * @returns 对应的沙箱检查动作（含动作目标）。
   */
  private sandboxActionOf(call: ToolCall): SandboxAction {
    if (
      call.name === 'read_file' ||
      call.name === 'grep' ||
      call.name === 'glob' ||
      // 读图（P2-⑬）与抓网页（P2-⑬）都不写本地文件，按「读」归类。
      call.name === 'view_image' ||
      call.name === 'web_fetch'
    ) {
      return { kind: 'file_read', target: this.targetOf(call) };
    }
    if (call.name === 'write_file' || call.name === 'edit' || call.name === 'apply_patch') {
      return { kind: 'file_write', target: this.targetOf(call) };
    }
    if (call.name === 'browser_screenshot') {
      // 落盘 PNG，与 write_file 同属写类；plan 模式应被拦（不进只读白名单）。
      return { kind: 'file_write', target: this.targetOf(call) };
    }
    return { kind: 'command', target: this.targetOf(call) };
  }

  /**
   * 提取动作目标（用于审批/沙箱展示与路径裁决）。
   *
   * `apply_patch` 的 `path` 官方描述即「可省略，缺省取 `+++` 头」；原实现因此在省略 `path` 时
   * 把工具名当成路径交给审批/沙箱 ⇒ **基于路径的策略拿不到真实目标**（与自验证旁路同源）。
   * 这里从补丁头就地取首个目标（纯字符串处理，不引入 adapters 依赖，守住 `core` 零适配器红线）。
   *
   * @param call 工具调用。
   * @returns command / path / url 参数值，或补丁头目标；均缺失时退化为工具名。
   */
  private targetOf(call: ToolCall): string {
    const direct = call.arguments['command'] ?? call.arguments['path'] ?? call.arguments['url'];
    if (typeof direct === 'string' && direct !== '') {
      return direct;
    }
    if (call.name === 'apply_patch') {
      const patch = call.arguments['patch'];
      if (typeof patch === 'string') {
        const match = /^\+\+\+ (.+)$/m.exec(patch);
        const path = match?.[1];
        if (path !== undefined && path !== '/dev/null') {
          return path.trim().replace(/^[ab]\//, '');
        }
      }
    }
    return call.name;
  }
}
