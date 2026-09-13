/**
 * policy_eval 工具（#S34）：让模型用安全策略规则集对一组事实求值，得到 allow/deny/ask 决策。
 *
 * 用于把沙箱命令审批、工具调用审批等决策「策略化、可审计、可解释」，而非硬编码。
 * 零依赖：仅依赖注入的 `PolicyPort`（默认 `SafePolicyEvaluator`）。
 */
import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../../ports/tool/tool.js';
import type { PolicyEffect, PolicyPort, PolicyRule } from '../../../ports/runtime/policy.js';
import { SafePolicyEvaluator } from '../../policy/safePolicyEvaluator.js';

/**
 * @beta
 */
export const POLICY_EVAL_TOOL_NAME = 'policy_eval';

/**
 * @beta
 */
export class PolicyEvalTool {
  /**
   * 工具定义：policy_eval 工具的名称、描述与参数 schema。
   * 用安全策略规则集对事实求值，得到 allow/deny/ask 决策，使审批策略化、可审计、可解释。
   */
  public readonly definition: ToolDefinition;

  public constructor(private readonly policy: PolicyPort = new SafePolicyEvaluator()) {
    this.definition = {
      name: POLICY_EVAL_TOOL_NAME,
      description:
        '用安全策略规则集（when 安全布尔表达式 → allow/deny/ask）对事实求值，得到决策与命中规则。' +
        '表达式支持 == != ~(正则) in(成员/子串) and or not 与括号；事实为 {标识符: 值}。',
      parameters: {
        type: 'object',
        properties: {
          rules: {
            type: 'array',
            description: '策略规则数组，每项 {name, when, effect(allow|deny|ask)}',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                when: { type: 'string' },
                effect: { type: 'string', enum: ['allow', 'deny', 'ask'] },
              },
              required: ['name', 'when', 'effect'],
            },
          },
          facts: { type: 'object', description: '事实表 {标识符: 值}' },
          default_effect: {
            type: 'string',
            enum: ['allow', 'deny', 'ask'],
            description: '无规则命中时的默认决策（缺省 ask）',
          },
        },
        required: ['rules', 'facts'],
      },
    };
  }

  /**
   * 执行 policy_eval：解析规则与事实、委托 PolicyPort 求值并返回决策与命中规则。
   * @param call 模型传入的工具调用（含 rules 数组、facts 对象、可选 default_effect）。
   * @param _ctx 工具执行上下文（本工具不依赖，保留签名兼容）。
   * @returns 成功返回 effect / matched_rule / warnings；参数非法或求值异常返回 ok:false。
   */
  public async handle(call: ToolCall, _ctx: ToolContext): Promise<ToolResult> {
    const rulesRaw = call.arguments['rules'];
    const factsRaw = call.arguments['facts'];
    if (!Array.isArray(rulesRaw) || typeof factsRaw !== 'object' || factsRaw === null) {
      return { callId: call.id, ok: false, error: 'rules 须为数组、facts 须为对象' };
    }
    const rules: PolicyRule[] = rulesRaw.map((r: Record<string, unknown>, idx: number) => {
      const name = String(r['name'] ?? `rule-${idx}`);
      const when = String(r['when'] ?? '');
      const effect = String(r['effect'] ?? 'ask') as PolicyEffect;
      return { name, when, effect };
    });
    const facts = factsRaw as Record<string, string | number | boolean | readonly string[]>;
    const defaultEffect = String(call.arguments['default_effect'] ?? 'ask') as PolicyEffect;
    try {
      const decision = this.policy.evaluate(rules, facts, defaultEffect);
      return {
        callId: call.id,
        ok: true,
        output: JSON.stringify({
          effect: decision.effect,
          matched_rule: decision.matchedRule,
          warnings: decision.warnings,
        }),
      };
    } catch (err) {
      return { callId: call.id, ok: false, error: `policy_eval 失败: ${(err as Error).message}` };
    }
  }
}
