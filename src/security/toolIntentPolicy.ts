import { log } from '../util/logger.ts';
import type { ToolCall } from '../ports/tool/tool.ts';

/** 工具意图类别（用于 per-action 授权；不是命令字符串黑白名单）。 */
export type ToolIntentKind =
  | 'read'
  | 'write'
  | 'delete'
  | 'exec'
  | 'network'
  | 'external_tool'
  | 'memory'
  | 'state'
  | 'unknown';

/** 意图风险级。 */
export type ToolIntentRisk = 'low' | 'medium' | 'high';

/** 一次工具的意图判定。 */
export interface ToolIntent {
  /** 工具名。 */
  readonly tool: string;
  /** 意图类别。 */
  readonly kind: ToolIntentKind;
  /** 风险级。 */
  readonly risk: ToolIntentRisk;
  /** 判定理由（人类可读，可进审计）。 */
  readonly reasons: readonly string[];
}

/** 策略模式。 */
export type ToolIntentMode = 'off' | 'shadow' | 'enforce';

/** 决策结果。 */
export interface ToolIntentDecision {
  /** 是否允许执行。 */
  readonly allow: boolean;
  /** 是否建议审批（当前 ToolGate 已有审批面；此位供上层接线）。 */
  readonly requireApproval: boolean;
  /** 拒绝/观察理由。 */
  readonly reason: string | undefined;
  /** 意图。 */
  readonly intent: ToolIntent;
}

/**
 * 每动作意图授权（2026-10-24）。
 *
 * 与现有审批/沙箱/RBAC 正交：审批回答「这次要不要人点确认」，沙箱回答「OS 能不能做」，
 * 本类回答「这个动作**是什么意图**、在当前策略下是否允许」。默认 `shadow`：只记录高风险
 * 意图，不改变行为；`enforce` 才拒绝。默认 shadow 是为了不在没有真实攻击样本时误伤正常命令。
 *
 * 为什么按「意图」而不是命令名：同一个 `shell` 可以是 `ls` 也可以是 `rm -rf /`；
 * 同一个 `write_file` 可以写 README 也可以写启动脚本。命令名黑白名单在参数层面没有意义。
 */
export class ToolIntentPolicy {
  /** 生效模式。 */
  private readonly mode: ToolIntentMode;

  /**
   * @param mode 策略模式（缺省读 `OMNI_INTENT_POLICY`，未设为 shadow）。
   */
  public constructor(mode: ToolIntentMode = ToolIntentPolicy.modeFromEnv()) {
    this.mode = mode;
  }

  /**
   * 从环境变量解析模式；未知值 fail-closed 到 shadow（不静默变 enforce）。
   * @returns 模式。
   */
  public static modeFromEnv(): ToolIntentMode {
    const raw = process.env.OMNI_INTENT_POLICY;
    if (raw === 'off' || raw === 'shadow' || raw === 'enforce') return raw;
    return 'shadow';
  }

  /**
   * 评估一次工具调用。
   * @param call 工具调用。
   * @returns 决策（含意图与理由）。
   */
  public evaluate(call: ToolCall): ToolIntentDecision {
    const intent = ToolIntentPolicy.classify(call);
    if (this.mode === 'off') {
      return { allow: true, requireApproval: false, reason: undefined, intent };
    }
    const high = intent.risk === 'high';
    if (this.mode === 'shadow') {
      if (high)
        log.warn('tool.intent.shadow_high_risk', { tool: call.name, reasons: intent.reasons });
      return { allow: true, requireApproval: high, reason: undefined, intent };
    }
    if (high) {
      const reason = `意图策略拒绝高风险动作（${intent.kind}）：${intent.reasons.join('；')}`;
      log.warn('tool.intent.denied', { tool: call.name, reasons: intent.reasons });
      return { allow: false, requireApproval: false, reason, intent };
    }
    return { allow: true, requireApproval: false, reason: undefined, intent };
  }

  /**
   * 把工具名 + 参数归类为意图。
   * @param call 工具调用。
   * @returns 意图。
   */
  public static classify(call: ToolCall): ToolIntent {
    const name = call.name;
    const args = call.arguments;
    const reasons: string[] = [];
    let kind: ToolIntentKind = 'unknown';
    let risk: ToolIntentRisk = 'low';
    if (/^(read_file|list_dir|glob|grep|lsp_|recall|memory_search)/u.test(name)) {
      kind = 'read';
    } else if (/^(write_file|edit_file|apply_patch|patch_candidates)/u.test(name)) {
      kind = 'write';
      risk = 'medium';
    } else if (/^(rollback|checkpoint|delete_file)/u.test(name)) {
      kind = 'delete';
      risk = 'high';
      reasons.push('可删除/回滚持久状态');
    } else if (/^(shell|run_code|shell_job|shell_interactive)/u.test(name)) {
      kind = 'exec';
      const text = String(args['command'] ?? args['code'] ?? '');
      const destructive = ToolIntentPolicy.destructiveCommand(text);
      risk = destructive ? 'high' : 'medium';
      if (destructive) reasons.push('命令命中破坏性模式');
    } else if (/^(web_fetch|web_search)/u.test(name)) {
      kind = 'network';
      risk = 'medium';
    } else if (/^(mcp|a2a)/u.test(name) || name.includes('__')) {
      kind = 'external_tool';
      risk = 'medium';
      reasons.push('外部工具（描述/行为不在本仓信任根内）');
    } else if (/^(remember|memory_|workflow_memory)/u.test(name)) {
      kind = 'memory';
      risk = 'medium';
    } else if (/^(checkpoint|rollback|plan_|todo_)/u.test(name)) {
      kind = 'state';
      risk = 'medium';
    }
    return { tool: name, kind, risk, reasons };
  }

  /**
   * 检测破坏性命令模式（保守；宁可 shadow 误报，不在 enforce 漏掉明显形态）。
   * @param command 命令/代码文本。
   * @returns 是否命中。
   */
  private static destructiveCommand(command: string): boolean {
    const text = command.toLowerCase();
    return (
      /rm\s+(-[a-z]*[rf][a-z]*\s+)*\/(?:\s|$)/u.test(text) ||
      /rm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(?:\/|~|\$home)/u.test(text) ||
      /del\s+\/[sq]\b/u.test(text) ||
      /format\s+[a-z]:/u.test(text) ||
      /mkfs(?:\.|\s)/u.test(text) ||
      /git\s+push\s+--force/u.test(text) ||
      /(?:curl|wget)[^|]*\|\s*(?:ba)?sh\b/u.test(text) ||
      /powershell(?:\.exe)?\s+-(?:enc|encodedcommand)\b/u.test(text) ||
      /(?:shutdown|reboot)\b/u.test(text)
    );
  }
}
