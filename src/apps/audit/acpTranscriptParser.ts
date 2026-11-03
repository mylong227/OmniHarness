import { AuditJsonl } from './auditJsonl.ts';
import { AcpToolWriter } from './acpToolWriter.ts';
import { AuditValues } from './auditValues.ts';
import type { AuditParseResult, AuditRecordDraft } from './auditTypes.ts';

/**
 * ACP 会话转录（JSON-RPC 帧的 JSONL）的解析器。
 *
 * 支持的帧形态（三者都常见）：
 * 1. 裸 JSON-RPC：`{jsonrpc:'2.0', method|result|error, params, id}`；
 * 2. 带方向包装：`{direction:'client-to-agent'|'agent-to-client', message:{…}}`；
 * 3. 带方向短名：`{dir:'c2s'|'s2c', frame:{…}}`。
 *
 * 时间戳：ACP 帧本身没有时间字段，若捕获器附了 `timestamp` / `ts` 则采用，否则为 null
 * （报告里"耗时"会显示为未知，不编造）。消息流按 `session/update` 的增量块合并成一条记录，
 * 避免一个 token 一条记录把时间线撑爆。
 */
export class AcpTranscriptParser {
  /** 会话 id。 */
  private sessionId: string | null = null;
  /** 工作区。 */
  private workspace: string | null = null;
  /** 模型名（ACP 帧里通常没有）。 */
  private model: string | null = null;
  /** 当前正在合并的增量块类别。 */
  private chunkKind: 'user' | 'assistant' | 'reasoning' | null = null;
  /** 当前增量块文本。 */
  private chunkText = '';
  /** 当前增量块时间戳。 */
  private chunkTs: string | null = null;
  /** 待响应的审批请求（id → 时间戳）。 */
  private readonly pendingApprovals = new Map<string, string | null>();
  /** 记录累加器。 */
  private records: AuditRecordDraft[] = [];

  /**
   * 解析一份 ACP 转录。
   * @param text 文件全文。
   * @returns 解析结果。
   * @throws Error 行数超上限时抛出。
   */
  public parse(text: string): AuditParseResult {
    this.reset();
    const { values, badLines } = AuditJsonl.parse(text);
    // 未识别条目计数用局部变量（实例字段会顶破本类的"上帝类"25 方法上限）：
    // 坏行逐条 +1；非帧行逐条 +1；帧级/块级由 handleFrame 的返回值（增量）累加。
    let unrecognized = badLines;
    for (const value of values) {
      const frame = this.frameOf(value);
      if (frame === null) {
        unrecognized += 1;
        continue;
      }
      unrecognized += this.handleFrame(frame);
    }
    this.flushChunk();
    return {
      format: 'acp',
      sessionId: this.sessionId,
      workspace: this.workspace,
      model: this.model,
      startedAt: this.firstTs(),
      endedAt: this.lastTs(),
      records: this.records,
      tokens: null,
      unrecognized,
    };
  }

  /**
   * 重置状态。
   * @returns 无返回值。
   */
  private reset(): void {
    this.sessionId = null;
    this.workspace = null;
    this.model = null;
    this.chunkKind = null;
    this.chunkText = '';
    this.chunkTs = null;
    this.pendingApprovals.clear();
    this.records = [];
  }

  /**
   * 从一行里取出 JSON-RPC 帧（兼容包装形态）。
   * @param value 解析后的值。
   * @returns 帧对象；认不出返回 null。
   */
  private frameOf(value: unknown): Record<string, unknown> | null {
    const record = AuditJsonl.recordOf(value);
    if (record === null) {
      return null;
    }
    const wrapped =
      AuditValues.record(record['message']) ??
      AuditValues.record(record['frame']) ??
      AuditValues.record(record['payload']);
    const candidate = wrapped ?? record;
    if (AuditValues.stringField(candidate, 'method') !== null) {
      return candidate;
    }
    if ('id' in candidate && ('result' in candidate || 'error' in candidate)) {
      return candidate;
    }
    return null;
  }

  /**
   * 分发一帧。
   * @param frame JSON-RPC 帧。
   * @returns 未识别条目增量（0 = 已识别；1 = method 认不出，原来整帧静默丢弃）。
   */
  private handleFrame(frame: Record<string, unknown>): number {
    const params = AuditValues.record(frame['params']);
    const ts = this.tsOf(frame);
    this.readSessionRefs(params);
    const method = AuditValues.stringField(frame, 'method');
    if (method === null) {
      this.handleResponse(frame, ts);
      return 0;
    }
    switch (method) {
      case 'session/update':
        return this.handleUpdate(params, ts);
      case 'session/prompt':
        this.flushChunk();
        this.handlePrompt(params, ts);
        return 0;
      case 'session/request_permission':
        this.flushChunk();
        this.handlePermissionRequest(frame, params, ts);
        return 0;
      case 'session/new':
        this.flushChunk();
        this.handleSessionNew(params, ts);
        return 0;
      case 'session/cancel':
        this.push('system', '会话取消', AuditValues.describe(params), ts);
        return 0;
      case 'initialize':
        this.push('session', 'ACP 初始化', AuditValues.describe(params), ts);
        return 0;
      default:
        // method 认不出（协议上游新增 / 捕获器噪音）：计入未识别（原来整帧静默丢弃）。
        return 1;
    }
  }

  /**
   * 读取会话 id / 工作区。
   * @param params 参数对象。
   * @returns 无返回值。
   */
  private readSessionRefs(params: Record<string, unknown> | null): void {
    if (params === null) {
      return;
    }
    this.sessionId = this.sessionId ?? AuditValues.stringField(params, 'sessionId');
    this.workspace = this.workspace ?? AuditValues.stringField(params, 'cwd');
  }

  /**
   * 读取 `session/update` 的增量。
   * @param params 参数对象。
   * @param ts 时间戳。
   * @returns 未识别条目增量（0 = 已识别；1 = update 对象缺失或类别认不出，原来整块静默丢弃）。
   */
  private handleUpdate(params: Record<string, unknown> | null, ts: string | null): number {
    const update = params === null ? null : AuditValues.record(params['update']);
    if (update === null) {
      return 1;
    }
    const kind = AuditValues.stringField(update, 'sessionUpdate');
    switch (kind) {
      case 'user_message_chunk':
        this.appendChunk('user', update, ts);
        return 0;
      case 'agent_message_chunk':
        this.appendChunk('assistant', update, ts);
        return 0;
      case 'agent_thought_chunk':
        this.appendChunk('reasoning', update, ts);
        return 0;
      case 'tool_call':
        this.flushChunk();
        AcpToolWriter.pushToolCall(this.records, update, ts);
        return 0;
      case 'tool_call_update':
        this.flushChunk();
        AcpToolWriter.pushToolResult(this.records, update, ts);
        return 0;
      case 'plan':
        this.flushChunk();
        this.push('other', '计划', AuditValues.describe(update['entries']), ts);
        return 0;
      default:
        // update 类别认不出（ACP 上游新增）：计入未识别（原来整块静默丢弃）。
        this.flushChunk();
        return 1;
    }
  }

  /**
   * 合并一个增量块。
   * @param kind 类别。
   * @param update update 对象。
   * @param ts 时间戳。
   * @returns 无返回值。
   */
  private appendChunk(
    kind: 'user' | 'assistant' | 'reasoning',
    update: Record<string, unknown>,
    ts: string | null,
  ): void {
    const content = AuditValues.record(update['content']);
    const text =
      content === null ? AuditValues.text(update['content']) : AuditValues.text(content['text']);
    if (text === null) {
      return;
    }
    if (this.chunkKind !== kind) {
      this.flushChunk();
      this.chunkKind = kind;
      this.chunkTs = ts;
    }
    this.chunkText += text;
  }

  /**
   * 落盘当前增量块。
   * @returns 无返回值。
   */
  private flushChunk(): void {
    if (this.chunkKind === null || this.chunkText === '') {
      this.chunkKind = null;
      this.chunkText = '';
      return;
    }
    const kind = this.chunkKind;
    const title = kind === 'assistant' ? '助手回复' : kind === 'user' ? '用户消息' : '思考';
    this.push(kind, title, this.chunkText, this.chunkTs);
    this.chunkKind = null;
    this.chunkText = '';
    this.chunkTs = null;
  }

  /**
   * 读取 `session/prompt` 请求（用户输入）。
   * @param params 参数对象。
   * @param ts 时间戳。
   * @returns 无返回值。
   */
  private handlePrompt(params: Record<string, unknown> | null, ts: string | null): void {
    if (params === null) {
      return;
    }
    const text = AuditValues.text(params['prompt']);
    if (text !== null) {
      this.push('user', '用户消息', text, ts);
    }
  }

  /**
   * 记录审批请求（等待响应）。
   * @param frame 帧。
   * @param params 参数。
   * @param ts 时间戳。
   * @returns 无返回值。
   */
  private handlePermissionRequest(
    frame: Record<string, unknown>,
    params: Record<string, unknown> | null,
    ts: string | null,
  ): void {
    const id = this.idOf(frame);
    if (id !== null) {
      this.pendingApprovals.set(id, ts);
    }
    this.records.push({
      ts,
      kind: 'approval',
      title: '审批请求',
      text: AuditValues.truncate(AuditValues.describe(params)),
      status: 'pending',
      ...(id !== null ? { callId: id } : {}),
    });
  }

  /**
   * 记录 `session/new` 请求或响应。
   * @param params 参数对象。
   * @param ts 时间戳。
   * @returns 无返回值。
   */
  private handleSessionNew(params: Record<string, unknown> | null, ts: string | null): void {
    if (params === null) {
      return;
    }
    this.workspace = this.workspace ?? AuditValues.stringField(params, 'cwd');
    // `session/new` 的结果里带 sessionId：response 分支会再走 handleResponse，这里只记工作区。
    this.push('session', '会话建立', AuditValues.describe(params), ts);
  }

  /**
   * 处理响应帧（审批结果 / 提示完成）。
   * @param frame 帧。
   * @param ts 时间戳。
   * @returns 无返回值。
   */
  private handleResponse(frame: Record<string, unknown>, ts: string | null): void {
    const id = this.idOf(frame);
    if (id === null) {
      return;
    }
    const result = AuditValues.record(frame['result']);
    if (result !== null) {
      this.sessionId = this.sessionId ?? AuditValues.stringField(result, 'sessionId');
    }
    if (this.pendingApprovals.has(id)) {
      const outcome = result === null ? null : AuditValues.record(result['outcome']);
      const option = outcome === null ? null : AuditValues.stringField(outcome, 'optionId');
      const cancelled =
        outcome === null ? false : AuditValues.stringField(outcome, 'outcome') === 'cancelled';
      this.pendingApprovals.delete(id);
      this.records.push({
        ts,
        kind: 'approval',
        title: '审批结果',
        text: option === null ? (cancelled ? '已取消' : '未作答') : option,
        callId: id,
        status: cancelled ? 'error' : 'ok',
      });
      return;
    }
    const error = AuditValues.record(frame['error']);
    if (error !== null) {
      this.push('error', '请求失败', AuditValues.describe(error), ts);
    }
  }

  /**
   * 追加一条记录。
   * @param kind 类别。
   * @param title 标题。
   * @param text 正文。
   * @param ts 时间戳。
   * @returns 无返回值。
   */
  private push(
    kind: AuditRecordDraft['kind'],
    title: string,
    text: string,
    ts: string | null,
  ): void {
    this.records.push({ ts, kind, title, text: AuditValues.truncate(text) });
  }

  /**
   * 取帧的 id（字符串化）。
   * @param frame 帧。
   * @returns id 或 null。
   */
  private idOf(frame: Record<string, unknown>): string | null {
    const id = frame['id'];
    if (typeof id === 'string') {
      return id;
    }
    return typeof id === 'number' ? String(id) : null;
  }

  /**
   * 取帧时间戳（捕获器可选附加）。
   * @param frame 帧。
   * @returns 时间戳或 null。
   */
  private tsOf(frame: Record<string, unknown>): string | null {
    return (
      AuditValues.stringField(frame, 'timestamp') ?? AuditValues.stringField(frame, 'ts') ?? null
    );
  }

  /**
   * 首条时间戳。
   * @returns 时间戳或 null。
   */
  private firstTs(): string | null {
    for (const record of this.records) {
      if (record.ts !== null) {
        return record.ts;
      }
    }
    return null;
  }

  /**
   * 末条时间戳。
   * @returns 时间戳或 null。
   */
  private lastTs(): string | null {
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      const record = this.records[index];
      if (record !== undefined && record.ts !== null) {
        return record.ts;
      }
    }
    return null;
  }
}
