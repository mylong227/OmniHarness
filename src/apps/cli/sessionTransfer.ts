import type { SessionEvent } from '../../contracts/ports/runtime/event.ts';
import type { StoragePort } from '../../contracts/ports/memory/storage.ts';

/**
 * 会话**导出/导入**（U3 平台互操作第一片，2026-10-31）。
 *
 * ## 回答什么
 *
 * 会话此前是**只进不出**的：事件日志锁在本机 `StoragePort` 里，「换机器 / 换存储后端 /
 * 把一段值得留档的会话交给别人」都没有出口。本模块给两条通路：
 *  - **导出**：`session export <id>` ⇒ 自描述信封（`omniharness.session.v1`，JSON），
 *    或 `--format claude-code` ⇒ Claude Code 会话 JSONL 的**最小**文本投影；
 *  - **导入**：`session import <file>` ⇒ 自动识别格式（omni 信封 / Claude Code JSONL）、
 *    重编事件 id、生成**新 sessionId**、把 `session_meta` 的 workspace 归到导入方工作区，
 *    经 `StoragePort.save` 落盘——导入的会话与本地会话同形态，`sessions.list` / replay 全可用。
 *
 * ## 口径（诚实边界）
 *
 * - **omni 格式是无损的**：事件逐条原样携带（含 tool_call/tool_result/turn_diff），
 *   导入后除 `sessionId`/`id`/`session_meta.workspace` 外逐位一致；
 * - **Claude Code 投影是降级的**：只映射 `user` / `assistant` 的**文本**（string 或
 *   text 块拼接）；`tool_use`/`tool_result`/`summary`/`system` 等一律跳过并**计数如实上报**
 *   ——跨 harness 的工具事件 schema 不同，硬映射等于编造历史；
 * - 导入**永远生成新 sessionId**（不覆盖既有会话）；重复导入同一文件会得到两个会话
 *   （幂等性由调用方判断，本模块不做内容去重——那是「静默改数据」）。
 */
export class SessionTransfer {
  /** 导出信封格式标记（自描述：导入侧据此识别）。 */
  public static readonly FORMAT = 'omniharness.session.v1' as const;

  /**
   * 导出为自描述信封（无损）。
   * @param storage 存储端口。
   * @param sessionId 会话 id。
   * @returns 信封（events 逐条原样）。
   */
  public static async exportSession(
    storage: StoragePort,
    sessionId: string,
  ): Promise<SessionExportEnvelope> {
    const events = await storage.load(sessionId);
    return {
      format: SessionTransfer.FORMAT,
      exportedAt: new Date().toISOString(),
      sourceSessionId: sessionId,
      eventCount: events.length,
      events,
    };
  }

  /**
   * 把信封投影为 Claude Code 会话 JSONL 的最小文本形态（user/assistant 文本行）。
   * @param envelope 导出信封。
   * @returns JSONL 文本（每行一个 JSON 对象，结尾换行）。
   */
  public static renderClaudeCode(envelope: SessionExportEnvelope): string {
    const lines: string[] = [];
    for (const event of envelope.events) {
      if (event.type !== 'user' && event.type !== 'assistant') continue;
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const content = typeof payload['content'] === 'string' ? payload['content'] : '';
      if (content === '') continue;
      lines.push(
        JSON.stringify({
          type: event.type,
          message: { role: event.type, content },
          timestamp: event.timestamp,
        }),
      );
    }
    return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  }

  /**
   * 解析导入文本（自动识别格式，fail-closed）。
   * @param text 文件全文。
   * @param opts 导入参数：`workspace` 导入方工作区（Claude Code 形态没有 workspace，需外部给）；
   *   `sessionId` **新会话 id**（导入永远生成新会话，事件落盘前就带上真 id——存储层原样写事件）。
   * @returns 重编后的事件流与格式来源（`skipped` = 被跳过的行数，如实上报）。
   * @throws 既不是 omni 信封也不是 Claude Code 会话 JSONL 时抛错（不猜）。
   */
  public static parseImport(
    text: string,
    opts: { readonly workspace: string; readonly sessionId: string },
  ): {
    readonly events: readonly SessionEvent[];
    readonly source: 'omni' | 'claude-code';
    readonly skipped: number;
  } {
    const trimmed = text.trim();
    if (trimmed === '') {
      throw new Error('导入文件为空');
    }
    const whole = SessionTransfer.tryParseJson(trimmed);
    if (
      whole !== undefined &&
      typeof whole === 'object' &&
      whole !== null &&
      whole['format'] === SessionTransfer.FORMAT
    ) {
      return {
        ...SessionTransfer.importOmni(
          whole as unknown as SessionExportEnvelope,
          opts.workspace,
          opts.sessionId,
        ),
        source: 'omni',
      };
    }
    return {
      ...SessionTransfer.importClaudeCode(trimmed, opts.workspace, opts.sessionId),
      source: 'claude-code',
    };
  }

  /**
   * 把解析出的事件流落盘为**新会话**。
   * @param storage 存储端口。
   * @param events 已重编的事件（见 {@link parseImport}）。
   * @param newSessionId 新会话 id（调用方生成；重复导入 = 新会话）。
   * @returns 落盘结果（sessionId 与事件数）。
   */
  public static async importSession(
    storage: StoragePort,
    events: readonly SessionEvent[],
    newSessionId: string,
  ): Promise<{ readonly sessionId: string; readonly count: number }> {
    await storage.save(newSessionId, events);
    return { sessionId: newSessionId, count: events.length };
  }

  /**
   * omni 信封 → 重编事件流（sessionId/workspace 归导入方，其余逐位保留）。
   * @param envelope 信封。
   * @param workspace 导入方工作区。
   * @param sessionId 新会话 id。
   * @returns 重编事件流与跳过数（0）。
   */
  private static importOmni(
    envelope: SessionExportEnvelope,
    workspace: string,
    sessionId: string,
  ): { readonly events: readonly SessionEvent[]; readonly skipped: number } {
    if (!Array.isArray(envelope.events)) {
      throw new Error('omni 信封缺 events 数组（文件损坏或被截断）');
    }
    const events = envelope.events.map((event, index) =>
      SessionTransfer.reid(event, index, workspace, sessionId),
    );
    return { events, skipped: 0 };
  }

  /**
   * Claude Code 会话 JSONL → 最小事件流（user/assistant 文本；其余跳过并计数）。
   * @param text JSONL 全文。
   * @param workspace 导入方工作区（合成 session_meta 用）。
   * @param sessionId 新会话 id。
   * @returns 事件流（首条恒为合成的 session_meta）与跳过行数。
   */
  private static importClaudeCode(
    text: string,
    workspace: string,
    sessionId: string,
  ): { readonly events: readonly SessionEvent[]; readonly skipped: number } {
    const lines = text.split('\n').filter((line) => line.trim() !== '');
    const events: SessionEvent[] = [];
    let skipped = 0;
    for (const line of lines) {
      const row = SessionTransfer.tryParseJson(line);
      if (row === undefined || typeof row !== 'object' || row === null) {
        skipped += 1;
        continue;
      }
      const type = row['type'];
      if (type !== 'user' && type !== 'assistant') {
        skipped += 1;
        continue;
      }
      const content = SessionTransfer.textContentOf(row['message']);
      if (content === '') {
        skipped += 1;
        continue;
      }
      events.push({
        id: '',
        type,
        sessionId: '',
        timestamp: typeof row['timestamp'] === 'string' ? row['timestamp'] : '',
        payload: { content },
      });
    }
    const meta: SessionEvent = {
      id: '',
      type: 'session_meta',
      sessionId: '',
      timestamp: events[0]?.timestamp ?? '',
      payload: { workspace },
    };
    const all = [meta, ...events];
    if (events.length === 0) {
      // fail-closed：整份文件没有一行能映射成 user/assistant ⇒ 要么不是会话文件，
      // 要么是全工具事件的 CC 会话（最小导入无法表达）。如实抛错，**绝不**产出一个
      // 只剩 session_meta 的空会话（那会让"导入成功"变成谎言）。
      throw new Error(
        `无法识别的会话格式（${String(skipped)} 行全部无法映射为 user/assistant 文本）` +
          '——支持：omniharness.session.v1 信封 / Claude Code 会话 JSONL',
      );
    }
    return {
      events: all.map((event, index) => SessionTransfer.reid(event, index, workspace, sessionId)),
      skipped,
    };
  }

  /**
   * 重编一条事件：id/seq 归零重排、sessionId 换新、session_meta 的 workspace 归导入方。
   * @param event 原事件。
   * @param index 序号（0 起，决定新 id）。
   * @param workspace 导入方工作区。
   * @param sessionId 新会话 id（事件落盘前必须带上真 id：存储层原样写事件）。
   * @returns 重编后的事件。
   */
  private static reid(
    event: SessionEvent,
    index: number,
    workspace: string,
    sessionId: string,
  ): SessionEvent {
    const id = `evt_imp${String(index + 1).padStart(4, '0')}`;
    if (event.type === 'session_meta') {
      const payload =
        typeof event.payload === 'object' && event.payload !== null
          ? { ...(event.payload as Record<string, unknown>), workspace }
          : { workspace };
      return { ...event, id, sessionId, payload };
    }
    const { seq: _dropped, ...rest } = event;
    return { ...rest, id, sessionId };
  }

  /**
   * Claude Code message 的文本内容（string 或 text 块拼接；无文本为空串）。
   * @param message message 对象（形态未知）。
   * @returns 拼接后的文本。
   */
  private static textContentOf(message: unknown): string {
    if (typeof message !== 'object' || message === null) return '';
    const content = (message as Record<string, unknown>)['content'];
    if (typeof content === 'string') return content.trim();
    if (!Array.isArray(content)) return '';
    const parts: string[] = [];
    for (const block of content) {
      if (
        typeof block === 'object' &&
        block !== null &&
        block['type'] === 'text' &&
        typeof block['text'] === 'string' &&
        block['text'].trim() !== ''
      ) {
        parts.push(block['text']);
      }
    }
    return parts.join('\n').trim();
  }

  /** JSON 解析（失败返回 undefined，不抛）。
   * @param text 候选 JSON 文本。
   * @returns 解析结果对象；解析失败为 undefined。
   */
  private static tryParseJson(text: string): Record<string, unknown> | undefined {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
}

/** 会话导出信封（自描述：`format` 恒为 `omniharness.session.v1`）。 */
export interface SessionExportEnvelope {
  readonly format: typeof SessionTransfer.FORMAT;
  readonly exportedAt: string;
  readonly sourceSessionId: string;
  readonly eventCount: number;
  readonly events: readonly SessionEvent[];
}
