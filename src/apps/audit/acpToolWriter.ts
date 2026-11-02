import { AuditToolPaths } from './auditToolPaths.ts';
import { AuditValues } from './auditValues.ts';
import type { AuditRecordDraft } from './auditTypes.ts';

/**
 * ACP `session/update` 里的**工具记录写入器**（`tool_call` / `tool_call_update`）。
 *
 * 抽出去的原因：ACP 解析器要同时处理帧分发、审批一问一答、增量块合并与工具记录，
 * 方法数会越过 `auditStandards` 的上帝类阈值（>25）。工具记录的三个方法在这里集中，
 * 解析器只负责"何时调用"。
 */
export class AcpToolWriter {
  /**
   * 工具调用记录。
   * @param records 记录累加器。
   * @param update update 对象。
   * @param ts 时间戳。
   * @returns 无返回值。
   */
  public static pushToolCall(
    records: AuditRecordDraft[],
    update: Record<string, unknown>,
    ts: string | null,
  ): void {
    const title = AuditValues.stringField(update, 'title') ?? '工具调用';
    const kind = AuditValues.stringField(update, 'kind');
    const callId = AuditValues.stringField(update, 'toolCallId');
    const files = AcpToolWriter.filesOfUpdate(update);
    records.push({
      ts,
      kind: 'tool_call',
      title,
      text: AuditValues.truncate(AuditValues.describe(update)),
      ...(kind !== null ? { tool: kind } : {}),
      ...(callId !== null ? { callId } : {}),
      status: 'pending',
      ...(files.length > 0 ? { files } : {}),
    });
  }

  /**
   * 工具调用更新（完成 / 失败时作为结果记录）。
   * @param records 记录累加器。
   * @param update update 对象。
   * @param ts 时间戳。
   * @returns 无返回值。
   */
  public static pushToolResult(
    records: AuditRecordDraft[],
    update: Record<string, unknown>,
    ts: string | null,
  ): void {
    const statusRaw = AuditValues.stringField(update, 'status');
    const status = statusRaw === 'completed' ? 'ok' : statusRaw === 'failed' ? 'error' : 'pending';
    const callId = AuditValues.stringField(update, 'toolCallId');
    const text =
      AuditValues.text(update['content']) ??
      AuditValues.text(update['rawOutput']) ??
      AuditValues.describe(update);
    records.push({
      ts,
      kind: 'tool_result',
      title: status === 'error' ? '工具失败' : '工具结果',
      text: AuditValues.truncate(text),
      ...(callId !== null ? { callId } : {}),
      status,
    });
  }

  /**
   * 从 `tool_call` 的 locations / rawInput 提取文件（只有写类工具/写类 `kind` 才计）。
   * @param update update 对象。
   * @returns 路径列表。
   */
  private static filesOfUpdate(update: Record<string, unknown>): string[] {
    const kind = AuditValues.stringField(update, 'kind');
    const title = AuditValues.stringField(update, 'title') ?? '';
    const writeKind =
      AuditToolPaths.isWriteTool(title) ||
      (kind !== null && ['edit', 'delete', 'move'].indexOf(kind) >= 0);
    if (!writeKind) {
      return [];
    }
    const found: string[] = [];
    for (const item of AuditValues.array(update['locations'])) {
      const location = AuditValues.record(item);
      const path = location === null ? null : AuditValues.stringField(location, 'path');
      if (path !== null) {
        found.push(path);
      }
    }
    const raw = AuditValues.record(update['rawInput']);
    found.push(...AuditToolPaths.fromArgs(raw));
    return found;
  }
}
