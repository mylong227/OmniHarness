import { TOOL_NAMES } from '../../../ports/tool/toolNames.ts';
import type { ToolCall, ToolDefinition, ToolResult } from '../../../ports/tool/tool.ts';
import type { ScratchpadPort } from '../../../ports/memory/scratchpad.ts';

/** read 动作缺省取的条数（与 ScratchpadPort.recent 的端口缺省一致）。 */
const DEFAULT_READ_K = 10;
/** read 动作的条数上限（防一次把 50 条全量灌进上下文）。 */
const MAX_READ_K = 50;

/**
 * 工作便签工具（T3.4 · 2026-11-01 接线收口）：`scratchpad` 是**跨上下文重置存活的
 * 轻量工作记忆**——此前便签存储（FileScratchpad）与配置接线全都在，却没有任何
 * 模型可用的读写入口，整条「重置后读回交接物恢复任务」的功能链断在最后一米。
 *
 * 三个动作：
 *  - `write`：追加交接便签（进行到哪 / 下一步 / 已确认约束），落盘
 *    `<workspace>/.omniharness/scratchpad.json`，保留最近 50 条；
 *  - `read`：取最近 k 条（新在前）——上下文压缩 / 中断 / 换会话续跑后先读再干；
 *  - `clear`：清空开新任务。
 *
 * 与检查点互补：checkpoint 存完整事件流状态（重），便签只存语义摘要（轻、人类可读）。
 * 写入是工作区状态变更 ⇒ 整工具按写类收进 MUTATING_TOOL_NAMES（read 一并被串行/plan 拦，
 * 与 run_code 的混合动作口径同型）。
 */
export class ScratchpadTool {
  /** 工具定义。 */
  public readonly definition: ToolDefinition = {
    name: TOOL_NAMES.scratchpad,
    description:
      '跨上下文重置的工作便签（交接物）。长任务推进到关键节点（阶段完成 / 将要压缩 / 做出决策）时' +
      '用 write 记下「进行到哪、下一步、已确认约束」；上下文被压缩、会话中断或换会话续跑后，' +
      '先 read 回最近便签恢复任务，不必重新考古事件日志。clear 在开新任务时清空旧便签。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'write 追加便签；read 取最近 k 条；clear 清空',
          enum: ['write', 'read', 'clear'],
        },
        text: {
          type: 'string',
          description: '便签正文（write 必填；建议一两句话，语义摘要而非流水账）',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '可选标签（如 ["D1", "决策"]），便于筛选',
        },
        k: { type: 'number', description: 'read 取的条数（默认 10，上限 50）' },
      },
      required: ['action'],
    },
  };

  /** 便签端口（FileScratchpad，file-backed 每次现读现写，多实例等价）。 */
  private readonly scratchpad: ScratchpadPort;

  /**
   * @param scratchpad 便签端口（装配自 memory 栈的 FileScratchpad）。
   */
  public constructor(scratchpad: ScratchpadPort) {
    this.scratchpad = scratchpad;
  }

  /**
   * 执行 scratchpad 动作。
   * @param call 模型传入的工具调用（action 必填；write 需 text）。
   * @returns write/clear 的受理回执或 read 的便签清单；非法参数/写盘失败 ok:false。
   */
  public async handle(call: ToolCall): Promise<ToolResult> {
    const action = call.arguments['action'];
    if (action === 'write') {
      const text = call.arguments['text'];
      if (typeof text !== 'string' || text.trim() === '') {
        return { callId: call.id, ok: false, error: 'write 需要 text（便签正文）' };
      }
      const rawTags = call.arguments['tags'];
      const tags = Array.isArray(rawTags)
        ? rawTags.filter((tag): tag is string => typeof tag === 'string')
        : undefined;
      const note = this.scratchpad.append(text, tags);
      if (note === undefined) {
        return {
          callId: call.id,
          ok: false,
          error: '便签写盘失败（fail-soft，请重试或检查工作区可写性）',
        };
      }
      return { callId: call.id, ok: true, output: `已记录便签 ${note.id}` };
    }
    if (action === 'read') {
      const rawK = call.arguments['k'];
      const k =
        typeof rawK === 'number' && Number.isFinite(rawK)
          ? Math.min(Math.max(1, Math.floor(rawK)), MAX_READ_K)
          : DEFAULT_READ_K;
      const notes = this.scratchpad.recent(k);
      if (notes.length === 0) {
        return { callId: call.id, ok: true, output: '（暂无便签）' };
      }
      const lines = notes.map((note) => {
        const tags =
          note.tags !== undefined && note.tags.length > 0 ? ` [${note.tags.join(',')}]` : '';
        return `${note.at}${tags} ${note.text}`;
      });
      return { callId: call.id, ok: true, output: lines.join('\n') };
    }
    if (action === 'clear') {
      this.scratchpad.clear();
      return { callId: call.id, ok: true, output: '已清空便签（新任务开编）' };
    }
    return { callId: call.id, ok: false, error: 'action 必须是 write | read | clear' };
  }
}
