/**
 * agent_identity 工具（#S33）：让模型用本 runtime 的密码学身份对负载签名/验签。
 *
 * 用途：工具结果、事件快照等关键产物可附 Ed25519 签名，下游凭公钥验证「确由本 runtime 出具」。
 * 零依赖：仅依赖注入的 `AgentIdentityPort`。
 */
import type {
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../../../ports/tool/tool.js';
import type { AgentIdentityPort } from '../../../ports/runtime/agentIdentity.js';
import { TOOL_NAMES } from '../../../ports/tool/toolNames.js';

/**
 * @beta
 * 工具名取自 `ports/tool/toolNames.ts`（单一来源）。
 */
export const AGENT_IDENTITY_TOOL_NAME = TOOL_NAMES.agentIdentity;

/**
 * @beta
 */
export class AgentIdentityTool {
  /**
   * 工具定义：agent_identity 工具的名称、描述与参数 schema。
   * 暴露本 runtime 的 Ed25519 密码学身份能力，支持 show / sign / verify / sign_assertion / verify_assertion 五种操作。
   */
  public readonly definition: ToolDefinition;

  public constructor(private readonly identity: AgentIdentityPort) {
    this.definition = {
      name: AGENT_IDENTITY_TOOL_NAME,
      description:
        '用本 runtime 的 Ed25519 密码学身份对负载签名或验签。operation=show 返回身份公钥；' +
        'sign 对 payload 签名；verify 验签；sign_assertion 签任务断言；verify_assertion 验任务断言。',
      parameters: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: ['show', 'sign', 'verify', 'sign_assertion', 'verify_assertion'],
            description: '操作类型',
          },
          payload: { type: 'string', description: 'sign/verify 的原始负载' },
          signature: { type: 'string', description: 'verify 的 base64 签名' },
          task_id: { type: 'string', description: 'sign_assertion/verify_assertion 的任务 id' },
          envelope: { type: 'string', description: 'verify_assertion 的 base64url 断言信封' },
        },
        required: ['operation'],
      },
    };
  }

  /**
   * 执行 agent_identity 工具调用，按 operation 分发到身份端口。
   * @param call 模型传入的工具调用（含 operation 及相应载荷参数）。
   * @param _ctx 工具执行上下文（本工具不依赖，保留签名兼容）。
   * @returns 签名/验签结果或身份信息；解析或执行异常时返回 ok:false 并附带错误信息。
   */
  public async handle(call: ToolCall, _ctx: ToolContext): Promise<ToolResult> {
    const op = String(call.arguments['operation'] ?? 'show');
    try {
      switch (op) {
        case 'show':
          return AgentIdentityTool.ok(
            call.id,
            JSON.stringify({
              agent_runtime_id: this.identity.runtimeId(),
              public_key_ssh: this.identity.publicKeySsh(),
            }),
          );
        case 'sign': {
          const payload = String(call.arguments['payload'] ?? '');
          return AgentIdentityTool.ok(
            call.id,
            JSON.stringify({ signature: this.identity.sign(payload) }),
          );
        }
        case 'verify': {
          const payload = String(call.arguments['payload'] ?? '');
          const signature = String(call.arguments['signature'] ?? '');
          return AgentIdentityTool.ok(
            call.id,
            JSON.stringify({ valid: this.identity.verify(payload, signature) }),
          );
        }
        case 'sign_assertion': {
          const taskId = String(call.arguments['task_id'] ?? 'default');
          return AgentIdentityTool.ok(
            call.id,
            JSON.stringify({
              envelope: this.identity.signAssertion(taskId),
              header: this.identity.authorizationHeader(taskId),
            }),
          );
        }
        case 'verify_assertion': {
          const envelope = String(call.arguments['envelope'] ?? '');
          const claims = this.identity.verifyAssertion(envelope);
          return AgentIdentityTool.ok(call.id, JSON.stringify({ valid: claims !== null, claims }));
        }
        default:
          return AgentIdentityTool.fail(call.id, `未知 operation: ${op}`);
      }
    } catch (err) {
      return AgentIdentityTool.fail(call.id, `agent_identity 失败: ${(err as Error).message}`);
    }
  }

  /** 构造成功结果。
   * @param callId 本次工具调用的权威 id（原实现恒传空串，会破坏 tool_call/tool_result 配对）。
   * @param output 成功输出文本。
   * @returns 带权威 callId 的工具结果。
   */
  private static ok(callId: string, output: string): ToolResult {
    return { callId, ok: true, output };
  }

  /** 构造失败结果。
   * @param callId 本次工具调用的权威 id。
   * @param message 失败原因。
   * @returns 带权威 callId 的工具结果。
   */
  private static fail(callId: string, message: string): ToolResult {
    return { callId, ok: false, error: message };
  }
}
