import { AuditJsonl } from './auditJsonl.ts';
import { AuditToolPaths } from './auditToolPaths.ts';
import { AuditValues } from './auditValues.ts';
import type { AuditParseResult, AuditRecordDraft, AuditTokenUsage } from './auditTypes.ts';

/**
 * Claude Code transcript（`~/.claude/projects/<project>/<session>.jsonl`）的解析器。
 *
 * 行形状（公开 transcript 格式，2026-11 快照）：
 * `{type:'user'|'assistant'|'system'|'summary', message?, timestamp, sessionId, cwd, uuid…}`；
 * 消息内容为字符串或多段块（`text` / `tool_use` / `tool_result` / `thinking`）。
 *
 * 诚实边界：transcript **不记录**权限审批的"谁批准了什么"（只有 permission mode 字段），
 * 因此本解析器不会伪造审批记录；需要审批链时用 OmniHarness 自家审计日志。
 */
export class ClaudeCodeParser {
  /** 会话 id。 */
  private sessionId: string | null = null;
  /** 工作区（cwd）。 */
  private workspace: string | null = null;
  /** 模型名（后出现的覆盖）。 */
  private model: string | null = null;
  /** 输入 token。 */
  private promptTokens = 0;
  /** 输出 token。 */
  private completionTokens = 0;
  /** 缓存读 token。 */
  private cachedTokens = 0;
  /** 总 token（含缓存读写）。 */
  private totalTokens = 0;
  /** 是否见过用量。 */
  private sawUsage = false;
  /** 记录累加器。 */
  private records: AuditRecordDraft[] = [];

  /**
   * 解析一份 Claude Code transcript。
   * @param text 文件全文。
   * @returns 解析结果。
   * @throws Error 行数超上限时抛出。
   */
  public parse(text: string): AuditParseResult {
    this.reset();
    const { values } = AuditJsonl.parse(text);
    for (const value of values) {
      const line = AuditJsonl.recordOf(value);
      if (line !== null) {
        this.handleLine(line);
      }
    }
    return {
      format: 'claude-code',
      sessionId: this.sessionId,
      workspace: this.workspace,
      model: this.model,
      startedAt: this.firstTs(),
      endedAt: this.lastTs(),
      records: this.records,
      tokens: this.sawUsage ? this.tokensOf() : null,
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
    this.promptTokens = 0;
    this.completionTokens = 0;
    this.cachedTokens = 0;
    this.totalTokens = 0;
    this.sawUsage = false;
    this.records = [];
  }

  /**
   * 分发一行。
   * @param line transcript 行对象。
   * @returns 无返回值。
   */
  private handleLine(line: Record<string, unknown>): void {
    const type = AuditValues.stringField(line, 'type');
    if (type === null) {
      return;
    }
    this.sessionId = this.sessionId ?? AuditValues.stringField(line, 'sessionId');
    this.workspace = this.workspace ?? AuditValues.stringField(line, 'cwd');
    const ts = AuditValues.stringField(line, 'timestamp');
    const message = AuditValues.record(line['message']);
    if (message !== null) {
      this.model = AuditValues.stringField(message, 'model') ?? this.model;
      this.readUsage(message);
      const role = AuditValues.stringField(message, 'role') ?? type;
      this.readContent(role, message, ts, line);
      return;
    }
    if (type === 'summary') {
      this.pushSimple('system', '摘要', AuditValues.stringField(line, 'summary') ?? '', ts);
      return;
    }
    if (type === 'system') {
      const text =
        AuditValues.text(line['content']) ??
        AuditValues.stringField(line, 'subtype') ??
        AuditValues.describe(line);
      this.pushSimple('system', '系统消息', text, ts);
      return;
    }
    this.pushSimple('other', type, AuditValues.describe(line), ts);
  }

  /**
   * 读取消息内容块。
   * @param role 角色（user / assistant）。
   * @param message 消息对象。
   * @param ts 时间戳。
   * @param line 原始行（toolUseResult 在行上）。
   * @returns 无返回值。
   */
  private readContent(
    role: string,
    message: Record<string, unknown>,
    ts: string | null,
    line: Record<string, unknown>,
  ): void {
    const content = message['content'];
    if (typeof content === 'string') {
      this.pushSimple(
        role === 'assistant' ? 'assistant' : 'user',
        role === 'assistant' ? '助手回复' : '用户消息',
        content,
        ts,
      );
      return;
    }
    for (const block of AuditValues.array(content)) {
      const record = AuditValues.record(block);
      if (record === null) {
        continue;
      }
      this.readBlock(record, role, ts, line);
    }
  }

  /**
   * 读取单个内容块。
   * @param block 内容块。
   * @param role 角色。
   * @param ts 时间戳。
   * @param line 原始行。
   * @returns 无返回值。
   */
  private readBlock(
    block: Record<string, unknown>,
    role: string,
    ts: string | null,
    line: Record<string, unknown>,
  ): void {
    const type = AuditValues.stringField(block, 'type');
    switch (type) {
      case 'text':
        this.pushSimple(
          role === 'assistant' ? 'assistant' : 'user',
          '正文',
          AuditValues.text(block['text']) ?? '',
          ts,
        );
        return;
      case 'thinking':
      case 'redacted_thinking':
        this.pushSimple('reasoning', '思考', AuditValues.text(block['thinking']) ?? '', ts);
        return;
      case 'tool_use':
        this.pushToolUse(block, ts);
        return;
      case 'tool_result':
        this.pushToolResult(block, ts, line);
        return;
      default:
        this.pushSimple('other', type ?? '内容块', AuditValues.describe(block), ts);
        return;
    }
  }

  /**
   * tool_use 块 → 工具调用记录。
   * @param block 内容块。
   * @param ts 时间戳。
   * @returns 无返回值。
   */
  private pushToolUse(block: Record<string, unknown>, ts: string | null): void {
    const name = AuditValues.stringField(block, 'name') ?? 'unknown';
    const input = AuditValues.record(block['input']);
    const command = input === null ? null : AuditValues.stringField(input, 'command');
    const files = AuditToolPaths.fromToolCall(name, input);
    const id = AuditValues.stringField(block, 'id');
    this.records.push({
      ts,
      kind: 'tool_call',
      title: name,
      text: AuditValues.truncate(command ?? AuditValues.describe(input)),
      tool: name,
      ...(id !== null ? { callId: id } : {}),
      status: 'pending',
      ...(files.length > 0 ? { files } : {}),
    });
  }

  /**
   * tool_result 块 → 工具结果记录。
   * @param block 内容块。
   * @param ts 时间戳。
   * @param line 原始行（toolUseResult 可能带文件路径）。
   * @returns 无返回值。
   */
  private pushToolResult(
    block: Record<string, unknown>,
    ts: string | null,
    line: Record<string, unknown>,
  ): void {
    const isError = AuditValues.boolField(block, 'is_error');
    const status = isError === true ? 'error' : isError === false ? 'ok' : 'pending';
    const id = AuditValues.stringField(block, 'tool_use_id');
    const result = AuditValues.record(line['toolUseResult']);
    const files = result === null ? [] : this.filesOfResult(result);
    this.records.push({
      ts,
      kind: 'tool_result',
      title: status === 'error' ? '工具失败' : '工具结果',
      text: AuditValues.truncate(AuditValues.text(block['content']) ?? AuditValues.describe(block)),
      ...(id !== null ? { callId: id } : {}),
      status,
      ...(files.length > 0 ? { files } : {}),
    });
  }

  /**
   * 从 `toolUseResult` 取文件（Claude Code 对写类工具会带 filePath）。
   * @param result 结果对象。
   * @returns 文件路径（去重）。
   */
  private filesOfResult(result: Record<string, unknown>): string[] {
    const found: string[] = [];
    for (const key of ['filePath', 'path', 'file_path']) {
      const value = AuditValues.stringField(result, key);
      if (value !== null) {
        found.push(AuditToolPaths.normalize(value));
      }
    }
    const patch = AuditValues.stringField(result, 'structuredPatch');
    if (patch !== null) {
      found.push(...AuditToolPaths.fromPatch(patch));
    }
    return found.filter((path) => path !== '');
  }

  /**
   * 读取 usage（Anthropic 口径：cache_read 不并入 input）。
   * @param message 消息对象。
   * @returns 无返回值。
   */
  private readUsage(message: Record<string, unknown>): void {
    const usage = AuditValues.record(message['usage']);
    if (usage === null) {
      return;
    }
    this.sawUsage = true;
    const input = AuditValues.numberField(usage, 'input_tokens') ?? 0;
    const output = AuditValues.numberField(usage, 'output_tokens') ?? 0;
    const cacheRead = AuditValues.numberField(usage, 'cache_read_input_tokens') ?? 0;
    const cacheCreate = AuditValues.numberField(usage, 'cache_creation_input_tokens') ?? 0;
    this.promptTokens += input + cacheCreate;
    this.completionTokens += output;
    this.cachedTokens += cacheRead;
    this.totalTokens += input + cacheCreate + cacheRead + output;
  }

  /**
   * 追加一条纯文本记录。
   * @param kind 类别。
   * @param title 标题。
   * @param text 正文。
   * @param ts 时间戳。
   * @returns 无返回值。
   */
  private pushSimple(
    kind: AuditRecordDraft['kind'],
    title: string,
    text: string,
    ts: string | null,
  ): void {
    if (text.trim() === '') {
      return;
    }
    this.records.push({ ts, kind, title, text: AuditValues.truncate(text) });
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

  /**
   * 汇总 token。
   * @returns 成本口径。
   */
  private tokensOf(): AuditTokenUsage {
    return {
      prompt: this.promptTokens,
      completion: this.completionTokens,
      cached: this.cachedTokens,
      total: this.totalTokens,
    };
  }
}
