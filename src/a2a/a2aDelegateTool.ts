/**
 * A2A 委托工具（U6 收口）——把「跨厂商 agent 委托」从半边能力接成全边。
 *
 * ## 断点在哪、怎么接
 *
 * `a2a.enabled` 时组合根已装配 server（收对等委托）**与** client（`runtime.a2a.client`），
 * 但 client 在生产路径上**零调用点**——本 agent 没有任何工具能发起委托，A2A 只有「被动收活」
 * 半边（README §7.3 的「客户端待建」过期，真实形态是「客户端在、工具面缺」）。
 * 本工具补上发起侧：模型经 `a2a_delegate` 把**自包含**子任务交给对等 agent 执行并回收结果。
 *
 * ## 注册与门控
 *
 * 由组合根（`Runtime.attachA2a`）在 client 就绪后**就地注册**进 `RegistryToolPort`——
 * 仅当 a2a.enabled 时本工具存在（不存在 ≠ 撒谎：没配对端时模型改用 subagent/delegate，
 * 那两条是真实执行路径）；自定义 ToolPort 的嵌入方可经 `runtime.a2a.client` 自行装配。
 *
 * ## 诚实边界
 *
 * 对端看不到本地会话历史——`task` 必须自包含（工具描述与空参拒绝都在强调这一点）；
 * 授权工具子集（`tools`）由对端 fail-closed 取交集执行（`A2aTaskExecutor` 剔除写类工具），
 * 本端只负责如实转述。
 */
import { randomUUID } from 'node:crypto';
import { TOOL_NAMES } from '../ports/tool/toolNames.js';
import type { ToolCall, ToolContext, ToolDefinition, ToolResult } from '../ports/tool/tool.js';
import type { A2aClient } from './a2aClient.js';

/**
 * A2A 委托工具：把自包含子任务委托给对等 agent，等待执行结果并转述。
 */
export class A2aDelegateTool {
  /** 工具定义。 */
  public readonly definition: ToolDefinition = {
    name: TOOL_NAMES.a2aDelegate,
    description:
      '把自包含子任务委托给对等 A2A agent（跨进程/跨厂商）执行并回收结果。' +
      '对端看不到本地历史，task 必须自包含；可用 tools 限制对端可用的工具子集。',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: '自包含的任务描述（对端无法访问本地会话/文件历史，所需上下文必须写全）',
        },
        tools: {
          type: 'array',
          items: { type: 'string' },
          description:
            '可选：授权对端使用的工具名清单（不传由对端自行决定；对端还会再剔除写类工具）',
        },
      },
      required: ['task'],
    },
  };

  /** 对等客户端（组合根在 a2a.enabled 装配后传入，工具生命周期与 client 绑定）。 */
  private readonly client: A2aClient;

  /**
   * @param client A2A 客户端（发送委托请求、接收结果与签名断言）。
   */
  public constructor(client: A2aClient) {
    this.client = client;
  }

  /**
   * 委托任务给对等 agent 并等待结果。
   * @param call 工具调用（实参含 task 与可选 tools）。
   * @param context 工具上下文（sessionId 作为 parentSessionId 供对端审计关联）。
   * @returns 对端输出（成功）或失败原因（对端拒绝/验签失败/超时/网络异常）。
   */
  public async handle(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    const task = typeof call.arguments['task'] === 'string' ? call.arguments['task'] : '';
    if (task.trim() === '') {
      return {
        callId: call.id,
        ok: false,
        error: 'a2a_delegate 需要非空 task（对端看不到本地历史，任务描述必须自包含）',
      };
    }
    const toolsRaw = call.arguments['tools'];
    const tools = Array.isArray(toolsRaw)
      ? toolsRaw.filter((t): t is string => typeof t === 'string')
      : undefined;
    try {
      const result = await this.client.delegateTask({
        taskId: `a2a-${randomUUID()}`,
        task,
        parentSessionId: context.sessionId,
        ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
      });
      return result.ok
        ? {
            callId: call.id,
            ok: true,
            output: `[a2a 对端] ${result.output}（steps=${String(result.steps)}，${String(result.durationMs)}ms）`,
          }
        : {
            callId: call.id,
            ok: false,
            error: `[a2a 对端] ${result.error ?? result.output}`,
          };
    } catch (error) {
      // 传输/验签/超时异常统一转可读错误（模型需要原因才能决定重试或改道）。
      return {
        callId: call.id,
        ok: false,
        error: `a2a 委托失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
