import type { ApprovalPort } from '../ports/approval.js';
import type { SupervisorPort } from '../ports/supervisor.js';
import type { SandboxAction, SandboxDecision, SandboxPort } from '../ports/sandbox.js';
import { UnsupportedSandbox } from '../adapters/sandbox/unsupportedSandbox.js';
import type { PlanPort } from '../ports/plan.js';
import type { ToolCall, ToolResult } from '../ports/tool.js';
import type { EscalationPort } from '../ports/escalation.js';

/**
 * @beta
 * 计划模式下被门禁拦截的"写类"工具（探索/提问/计划类工具不在其列）。
 */
export const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  'shell',
  'write_file',
  'apply_patch',
  'delegate',
  'subagent',
]);

/**
 * @beta
 * 工具门禁：审批 + 沙箱 + 计划态三道门禁统一裁决（fail-closed，任意拒绝即拦截）。
 */
export class ToolGate {
  constructor(
    private readonly approvals: ApprovalPort,
    private readonly sandbox: SandboxPort,
    private readonly plan?: PlanPort,
    private readonly planMode = false,
    /** 升级审批端口（#G3/G4）：仅沙箱拒绝时咨询；审批策略拒绝不升级，避免绕过既定策略。 */
    private readonly escalation?: EscalationPort,
    /** 提权后的复核沙箱（默认 fail-closed：未显式注入时一律拒绝升级，绝不静默全放行。
     *  ConfigFactory 实际注入 PolicySandbox 做收紧；本默认仅为防御性兜底，
     *  防止任何手动构造 ToolGate 漏注入 elevatedSandbox 时把提权重试变成沙箱绕过）。 */
    private readonly elevatedSandbox: SandboxPort = new UnsupportedSandbox(
      'elevated',
      '提权沙箱未注入，默认 fail-closed 拒绝升级',
    ),
    /** 航天级监督内核（I-P0-3，可选）：最高优先级确定性否决，置于审批/沙箱/计划门禁之前。 */
    private readonly supervisor?: SupervisorPort,
  ) {}

  /** 门禁检查：通过返回 undefined，否则返回带具体原因的拒绝结果（可观测性 #OBS-1：plan/审批/沙箱各自的真实拒绝原因透传，便于 UI/日志归因）。 */
  async gate(call: ToolCall, sessionId: string): Promise<ToolResult | undefined> {
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

  /** 取具体拒绝原因；未拒绝返回 undefined。区分 plan / 审批 / 沙箱三类，便于 UI 归因（G3 可观测性）。 */
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

  /** 沙箱拒绝后的升级尝试：escalate 且提权沙箱放行则返回 true（放行），否则保持拒绝。 */
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

  /** 按工具类型映射沙箱动作（命令/读/写）。 */
  private sandboxActionOf(call: ToolCall): SandboxAction {
    if (call.name === 'read_file') {
      return { kind: 'file_read', target: this.targetOf(call) };
    }
    if (call.name === 'write_file' || call.name === 'apply_patch') {
      return { kind: 'file_write', target: this.targetOf(call) };
    }
    return { kind: 'command', target: this.targetOf(call) };
  }

  /** 提取动作目标（用于审批/沙箱展示）。 */
  private targetOf(call: ToolCall): string {
    return String(call.arguments['command'] ?? call.arguments['path'] ?? call.name);
  }
}
