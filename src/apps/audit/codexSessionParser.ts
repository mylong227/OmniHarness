import { AuditJsonl } from './auditJsonl.ts';
import { AuditValues } from './auditValues.ts';
import { CodexLineWriter } from './codexLineWriter.ts';
import type { CodexParseContext } from './codexParseContext.ts';
import type { AuditParseResult, AuditRecordDraft, AuditTokenUsage } from './auditTypes.ts';

/**
 * Codex CLI session rollout（`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`）的解析器。
 *
 * 本类只做**读行 → 分发 → 汇总**；`response_item` / `event_msg` 的字段解释在
 * {@link CodexLineWriter}（拆出去是为了不越过"上帝类"判据，同时把两条支路的去重口径收在一处）。
 *
 * 去重口径：同一份 rollout 常同时含 `response_item` 消息与 `event_msg` 的
 * `user_message` / `agent_message`。当且仅当本文件出现过 `response_item` 消息时，
 * 以 `response_item` 为准、跳过 `event_msg` 文本副本（否则会一条用户话出现两次）；
 * 只有 `event_msg` 的老格式则反过来只用 `event_msg`。
 */
export class CodexSessionParser {
  /** 会话 id。 */
  private sessionId: string | null = null;
  /** 工作区。 */
  private workspace: string | null = null;
  /** 模型名。 */
  private model: string | null = null;
  /** 共享上下文（记录 / 去重 / 成本）。 */
  private context: CodexParseContext = CodexSessionParser.emptyContext();
  /** 未识别的来源条目数（口径见 `docs/audit/ATTESTATION.md` §3）。 */
  private unrecognized = 0;

  /**
   * 解析一份 Codex rollout。
   * @param text 文件全文。
   * @returns 解析结果。
   * @throws Error 行数超上限时抛出。
   */
  public parse(text: string): AuditParseResult {
    this.reset();
    const { values, badLines } = AuditJsonl.parse(text);
    this.unrecognized = badLines;
    const parsed = values.map((value) => AuditJsonl.recordOf(value));
    for (const line of parsed) {
      if (line === null) {
        this.unrecognized += 1;
      }
    }
    const lines = parsed.filter((line): line is Record<string, unknown> => line !== null);
    this.context.hasResponseMessages = lines.some((line) => this.isResponseMessage(line));
    for (const line of lines) {
      this.handleLine(line);
    }
    if (this.context.tokens.sawUsage) {
      this.context.records.push({
        ts: null,
        kind: 'other',
        title: '模型用量',
        text: '',
        meta: {
          prompt: this.context.tokens.prompt,
          completion: this.context.tokens.completion,
          cached: this.context.tokens.cached,
          total: this.context.tokens.total,
        },
      });
    }
    return {
      format: 'codex',
      sessionId: this.sessionId,
      workspace: this.workspace,
      model: this.model,
      startedAt: this.firstTs(),
      endedAt: this.lastTs(),
      records: this.context.records,
      tokens: this.context.tokens.sawUsage ? this.tokensOf() : null,
      unrecognized: this.unrecognized,
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
    this.context = CodexSessionParser.emptyContext();
    this.unrecognized = 0;
  }

  /**
   * 构造空上下文。
   * @returns 空上下文。
   */
  private static emptyContext(): CodexParseContext {
    return {
      records: [],
      seenCalls: new Set<string>(),
      hasResponseMessages: false,
      tokens: { prompt: 0, completion: 0, cached: 0, total: 0, sawUsage: false },
    };
  }

  /**
   * 判断一行是否是 `response_item` 里的消息。
   * @param line 行对象。
   * @returns 是则为 true。
   */
  private isResponseMessage(line: Record<string, unknown>): boolean {
    if (AuditValues.stringField(line, 'type') !== 'response_item') {
      return false;
    }
    const payload = AuditValues.record(line['payload']);
    return payload !== null && AuditValues.stringField(payload, 'type') === 'message';
  }

  /**
   * 分发一行。
   * @param line 行对象。
   * @returns 无返回值。
   */
  private handleLine(line: Record<string, unknown>): void {
    const type = AuditValues.stringField(line, 'type');
    const ts = AuditValues.stringField(line, 'timestamp');
    const payload = AuditValues.record(line['payload']);
    if (type === null || payload === null) {
      // 类型缺失 / 载荷缺失的行无法按 rollout 口径解释：计入未识别（原来静默丢弃）。
      this.unrecognized += 1;
      return;
    }
    switch (type) {
      case 'session_meta':
        this.readMeta(payload, ts);
        return;
      case 'turn_context':
        this.readTurnContext(payload, ts);
        return;
      case 'response_item':
        CodexLineWriter.read(this.context, payload, ts);
        return;
      case 'event_msg':
        CodexLineWriter.readEvent(this.context, payload, ts);
        return;
      case 'compacted':
        this.context.records.push({
          ts,
          kind: 'system',
          title: '上下文已压缩',
          text: AuditValues.truncate(AuditValues.describe(payload)),
        });
        return;
      default:
        // 顶层类型未知（上游格式漂移）：计入未识别，同时以 other 记录保留载荷（证据不丢）。
        this.unrecognized += 1;
        this.context.records.push({
          ts,
          kind: 'other',
          title: type,
          text: AuditValues.truncate(AuditValues.describe(payload)),
        });
        return;
    }
  }

  /**
   * 读取 `session_meta`。
   * @param payload 载荷。
   * @param ts 时间戳。
   * @returns 无返回值。
   */
  private readMeta(payload: Record<string, unknown>, ts: string | null): void {
    this.sessionId = this.sessionId ?? AuditValues.stringField(payload, 'id');
    this.workspace = this.workspace ?? AuditValues.stringField(payload, 'cwd');
    this.model = this.model ?? AuditValues.stringField(payload, 'model');
    const version = AuditValues.stringField(payload, 'cli_version');
    const summary = [
      this.workspace === null ? null : `workspace: ${this.workspace}`,
      this.model === null ? null : `model: ${this.model}`,
      version === null ? null : `cli: ${version}`,
    ]
      .filter((item): item is string => item !== null)
      .join('\n');
    this.context.records.push({
      ts,
      kind: 'session',
      title: '会话开始',
      text: AuditValues.truncate(summary),
    });
  }

  /**
   * 读取 `turn_context`（模型 / 审批策略 / 沙箱策略）。
   * @param payload 载荷。
   * @param ts 时间戳。
   * @returns 无返回值。
   */
  private readTurnContext(payload: Record<string, unknown>, ts: string | null): void {
    this.model = AuditValues.stringField(payload, 'model') ?? this.model;
    this.workspace = this.workspace ?? AuditValues.stringField(payload, 'cwd');
    const approval = AuditValues.stringField(payload, 'approval_policy');
    const sandbox = AuditValues.stringField(payload, 'sandbox_policy');
    const text = [
      approval === null ? null : `approval: ${approval}`,
      sandbox === null ? null : `sandbox: ${sandbox}`,
    ]
      .filter((item): item is string => item !== null)
      .join('\n');
    if (text !== '') {
      this.context.records.push({
        ts,
        kind: 'system',
        title: '回合上下文',
        text: AuditValues.truncate(text),
      });
    }
  }

  /**
   * 首条时间戳。
   * @returns 时间戳或 null。
   */
  private firstTs(): string | null {
    for (const record of this.context.records) {
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
    const records: readonly AuditRecordDraft[] = this.context.records;
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index];
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
      prompt: this.context.tokens.prompt,
      completion: this.context.tokens.completion,
      cached: this.context.tokens.cached,
      total: this.context.tokens.total,
    };
  }
}
