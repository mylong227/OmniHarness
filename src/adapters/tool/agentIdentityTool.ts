/**
 * agent_identity 工具（#S33）：让模型用本 runtime 的密码学身份对负载签名/验签。
 *
 * 用途：工具结果、事件快照等关键产物可附 Ed25519 签名，下游凭公钥验证「确由本 runtime 出具」。
 * 零依赖：仅依赖注入的 `AgentIdentityPort`。
 */
import type { ToolCall, ToolContext, ToolDefinition, ToolResult } from '../../ports/tool.js';
import type { AgentIdentityPort } from '../../ports/agentIdentity.js';

/**
 * @beta
 */
export const AGENT_IDENTITY_TOOL_NAME = 'agent_identity';

/**
 * @beta
 */
export class AgentIdentityTool {
  readonly definition: ToolDefinition;

  constructor(private readonly identity: AgentIdentityPort) {
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

  async handle(call: ToolCall, _ctx: ToolContext): Promise<ToolResult> {
    const op = String(call.arguments['operation'] ?? 'show');
    try {
      switch (op) {
        case 'show':
          return ok(
            JSON.stringify({
              agent_runtime_id: this.identity.runtimeId(),
              public_key_ssh: this.identity.publicKeySsh(),
            }),
          );
        case 'sign': {
          const payload = String(call.arguments['payload'] ?? '');
          return ok(JSON.stringify({ signature: this.identity.sign(payload) }));
        }
        case 'verify': {
          const payload = String(call.arguments['payload'] ?? '');
          const signature = String(call.arguments['signature'] ?? '');
          return ok(JSON.stringify({ valid: this.identity.verify(payload, signature) }));
        }
        case 'sign_assertion': {
          const taskId = String(call.arguments['task_id'] ?? 'default');
          return ok(
            JSON.stringify({
              envelope: this.identity.signAssertion(taskId),
              header: this.identity.authorizationHeader(taskId),
            }),
          );
        }
        case 'verify_assertion': {
          const envelope = String(call.arguments['envelope'] ?? '');
          const claims = this.identity.verifyAssertion(envelope);
          return ok(JSON.stringify({ valid: claims !== null, claims }));
        }
        default:
          return fail(`未知 operation: ${op}`);
      }
    } catch (err) {
      return fail(`agent_identity 失败: ${(err as Error).message}`);
    }
  }
}

function ok(output: string): ToolResult {
  return { callId: '', ok: true, output };
}

function fail(message: string): ToolResult {
  return { callId: '', ok: false, error: message };
}
