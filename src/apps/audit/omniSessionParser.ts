import { AuditJsonl } from './auditJsonl.ts';
import { AuditToolPaths } from './auditToolPaths.ts';
import { AuditValues } from './auditValues.ts';
import type { AuditParseResult, AuditRecordDraft, AuditTokenUsage } from './auditTypes.ts';

/**
 * OmniHarness 自家会话（`~/.omniharness/sessions/*.jsonl`）的解析器。
 *
 * 事件形状（`SessionEvent`）：`{id,type,sessionId,timestamp,seq?,payload}`。本解析器只认
 * `EventType` 里的类型，未知类型记成 `other`（不丢证据、也不猜语义）。
 *
 * 口径说明：
 * - `model` 事件逐条进时间线（kind `other`）而不是只做汇总——汇总若不被链覆盖，
 *   改掉"花了多少"就无法检出；
 * - `turn_diff` 的正文是 diff 头部（受字符上限），增删行数进 `meta` 与文件表。
 */
export class OmniSessionParser {
  /** 解析结果的可变累加器（每次 `parse` 重置）。 */
  private sessionId: string | null = null;
  /** 工作区。 */
  private workspace: string | null = null;
  /** 模型名（后出现的覆盖先出现的）。 */
  private model: string | null = null;
  /** token 累加（null = 源里没有用量事件）。 */
  private promptTokens = 0;
  /** 完成 token 数。 */
  private completionTokens = 0;
  /** 缓存读 token 数（不并入 prompt）。 */
  private cachedTokens = 0;
  /** 总 token 数。 */
  private totalTokens = 0;
  /** 是否见过用量事件。 */
  private sawUsage = false;
  /** 已产出的记录。 */
  private records: AuditRecordDraft[] = [];
  /** 未识别的来源条目数（口径见 `docs/audit/ATTESTATION.md` §3）。 */
  private unrecognized = 0;

  /**
   * 解析一份 OmniHarness 会话 JSONL。
   * @param text 文件全文。
   * @returns 解析结果（尚未编号、未上链）。
   * @throws Error 行数超上限时抛出。
   */
  public parse(text: string): AuditParseResult {
    this.reset();
    const envelope = this.envelopeEvents(text);
    if (envelope === null) {
      const { values, badLines } = AuditJsonl.parse(text);
      this.unrecognized += badLines;
      for (const value of values) {
        const event = AuditJsonl.recordOf(value);
        if (event === null) {
          this.unrecognized += 1;
          continue;
        }
        this.handleEvent(event);
      }
    } else {
      for (const value of envelope) {
        const event = AuditJsonl.recordOf(value);
        if (event === null) {
          this.unrecognized += 1;
          continue;
        }
        this.handleEvent(event);
      }
    }
    return {
      format: 'omni',
      sessionId: this.sessionId,
      workspace: this.workspace,
      model: this.model,
      startedAt: this.firstTsOf(this.records),
      endedAt: this.lastTsOf(this.records),
      records: this.records,
      tokens: this.sawUsage ? this.tokensOf() : null,
      unrecognized: this.unrecognized,
    };
  }

  /**
   * 识别 `session export` 的自描述信封并取出事件数组。
   *
   * 信封是**单个 JSON 对象**（可能被格式化工具排成多行），不等于"一行一个事件"的会话
   * JSONL；因此先按全文解析，失败再回落到 JSONL 逐行口径。`includes` 预筛避免对
   * 60 MB 的普通 JSONL 做一次注定失败的全量 `JSON.parse`。
   * @param text 文件全文。
   * @returns 事件数组；不是信封返回 null。
   */
  private envelopeEvents(text: string): readonly unknown[] | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith('{') || !trimmed.includes('omniharness.session.v1')) {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const envelope = AuditValues.record(parsed);
      if (envelope === null || envelope['format'] !== 'omniharness.session.v1') {
        return null;
      }
      const events = envelope['events'];
      return Array.isArray(events) ? events : null;
    } catch {
      return null;
    }
  }

  /**
   * 重置累加器。
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
    this.unrecognized = 0;
  }

  /**
   * 分发一条事件。
   * @param event 事件对象。
   * @returns 无返回值。
   */
  private handleEvent(event: Record<string, unknown>): void {
    const type = AuditValues.stringField(event, 'type');
    if (type === null) {
      this.unrecognized += 1;
      return;
    }
    this.sessionId = this.sessionId ?? AuditValues.stringField(event, 'sessionId');
    const ts = AuditValues.stringField(event, 'timestamp');
    const payload = AuditValues.record(event['payload']);
    switch (type) {
      case 'session_meta':
        this.readMeta(payload, ts);
        break;
      case 'user':
        this.push('user', '用户消息', this.contentOf(payload), ts);
        break;
      case 'assistant':
        this.push('assistant', '助手回复', this.contentOf(payload), ts);
        break;
      case 'reasoning':
        this.push('reasoning', '思考', this.contentOf(payload), ts);
        break;
      case 'tool_call':
        this.pushToolCall(payload, ts);
        break;
      case 'tool_result':
        this.pushToolResult(payload, ts);
        break;
      case 'turn_diff':
        this.pushTurnDiff(payload, ts);
        break;
      case 'model':
        this.pushModel(payload, ts);
        break;
      case 'system':
        this.push('system', '系统消息', this.contentOf(payload), ts);
        break;
      default:
        // 顶层类型未知（上游新增事件 / 漂移）：计入未识别，同时以 other 记录保留载荷（证据不丢）。
        // `model` 是已知类型（走上方 case），其 kind 虽为 other 但**不**计入未识别。
        this.unrecognized += 1;
        this.push('other', type, AuditValues.describe(payload), ts);
        break;
    }
  }

  /**
   * 读取 `session_meta`（工作区 / 模型），并落一条会话开始记录。
   * @param payload 事件载荷。
   * @param ts 时间戳。
   * @returns 无返回值。
   */
  private readMeta(payload: Record<string, unknown> | null, ts: string | null): void {
    if (payload === null) {
      return;
    }
    this.workspace = this.workspace ?? AuditValues.stringField(payload, 'workspace');
    this.model = this.model ?? AuditValues.stringField(payload, 'model');
    const manifest = AuditValues.record(payload['manifest']);
    if (manifest !== null) {
      this.workspace = this.workspace ?? AuditValues.stringField(manifest, 'workspace');
      this.model = this.model ?? AuditValues.stringField(manifest, 'model');
    }
    const summary = [
      this.workspace === null ? null : `workspace: ${this.workspace}`,
      this.model === null ? null : `model: ${this.model}`,
    ]
      .filter((item): item is string => item !== null)
      .join('\n');
    this.push('session', '会话开始', summary, ts);
  }

  /**
   * 取消息正文（`payload.content`，兼容 `text`）。
   * @param payload 事件载荷。
   * @returns 正文；无则空串。
   */
  private contentOf(payload: Record<string, unknown> | null): string {
    if (payload === null) {
      return '';
    }
    const text =
      AuditValues.text(payload['content']) ??
      AuditValues.text(payload['text']) ??
      AuditValues.describe(payload);
    return text;
  }

  /**
   * 工具调用记录。
   * @param payload 事件载荷。
   * @param event 原始事件（取时间戳）。
   * @returns 无返回值。
   */
  private pushToolCall(payload: Record<string, unknown> | null, ts: string | null): void {
    if (payload === null) {
      return;
    }
    const name = AuditValues.stringField(payload, 'name') ?? 'unknown';
    const args = AuditValues.record(payload['args']) ?? AuditValues.record(payload['arguments']);
    const command = args === null ? null : AuditValues.stringField(args, 'command');
    const text = command !== null ? command : AuditValues.describe(args);
    const files = AuditToolPaths.fromToolCall(name, args);
    const callId =
      AuditValues.stringField(payload, 'callId') ?? AuditValues.stringField(payload, 'id');
    this.records.push({
      ts,
      kind: 'tool_call',
      title: name,
      text: AuditValues.truncate(text),
      tool: name,
      ...(callId !== null ? { callId } : {}),
      status: 'pending',
      ...(files.length > 0 ? { files } : {}),
    });
  }

  /**
   * 工具结果记录。
   * @param payload 事件载荷。
   * @returns 无返回值。
   */
  private pushToolResult(payload: Record<string, unknown> | null, ts: string | null): void {
    if (payload === null) {
      return;
    }
    const ok = AuditValues.boolField(payload, 'ok');
    const status = ok === null ? 'pending' : ok ? 'ok' : 'error';
    const output =
      AuditValues.text(payload['output']) ??
      AuditValues.text(payload['content']) ??
      AuditValues.describe(payload);
    const callId =
      AuditValues.stringField(payload, 'callId') ?? AuditValues.stringField(payload, 'id');
    this.records.push({
      ts,
      kind: 'tool_result',
      title: status === 'error' ? '工具失败' : '工具结果',
      text: AuditValues.truncate(output),
      ...(callId !== null ? { callId } : {}),
      status,
    });
  }

  /**
   * 回合 diff 记录。
   * @param payload 事件载荷。
   * @returns 无返回值。
   */
  private pushTurnDiff(payload: Record<string, unknown> | null, ts: string | null): void {
    const diff = payload === null ? null : AuditValues.stringField(payload, 'diff');
    if (diff === null) {
      return;
    }
    const stats = AuditToolPaths.diffStats(diff);
    const files = stats.map((item) => item.path);
    const summary = stats
      .map((item) => `${item.path} +${String(item.added)}/−${String(item.removed)}`)
      .join('\n');
    this.records.push({
      ts,
      kind: 'turn',
      title: '回合变更',
      text: AuditValues.truncate(summary === '' ? diff : `${summary}\n\n${diff}`),
      ...(files.length > 0 ? { files } : {}),
      ...(stats.length > 0 ? { fileStats: stats } : {}),
      meta: {
        files: files.length,
        added: stats.reduce((sum, item) => sum + item.added, 0),
        removed: stats.reduce((sum, item) => sum + item.removed, 0),
      },
    });
  }

  /**
   * 模型用量记录（同时累加成本）。
   * @param payload 事件载荷。
   * @returns 无返回值。
   */
  private pushModel(payload: Record<string, unknown> | null, ts: string | null): void {
    if (payload === null) {
      return;
    }
    this.model = AuditValues.stringField(payload, 'model') ?? this.model;
    const usage = AuditValues.record(payload['usage']);
    if (usage === null) {
      return;
    }
    this.sawUsage = true;
    const prompt = AuditValues.numberField(usage, 'promptTokens') ?? 0;
    const completion = AuditValues.numberField(usage, 'completionTokens') ?? 0;
    const cached = AuditValues.numberField(usage, 'cachedPromptTokens') ?? 0;
    const total = AuditValues.numberField(usage, 'totalTokens') ?? prompt + completion;
    this.promptTokens += prompt;
    this.completionTokens += completion;
    this.cachedTokens += cached;
    this.totalTokens += total;
    this.records.push({
      ts,
      kind: 'other',
      title: '模型用量',
      text: '',
      meta: { prompt, completion, cached, total },
    });
  }

  /**
   * 追加一条纯文本记录。
   * @param kind 记录类别。
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
    this.records.push({
      ts,
      kind,
      title,
      text: AuditValues.truncate(text),
    });
  }

  /**
   * 首条时间戳。
   * @param records 记录列表。
   * @returns 第一个非空时间戳或 null。
   */
  private firstTsOf(records: readonly AuditRecordDraft[]): string | null {
    for (const record of records) {
      if (record.ts !== null) {
        return record.ts;
      }
    }
    return null;
  }

  /**
   * 末条时间戳。
   * @param records 记录列表。
   * @returns 最后一个非空时间戳或 null。
   */
  private lastTsOf(records: readonly AuditRecordDraft[]): string | null {
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
      prompt: this.promptTokens,
      completion: this.completionTokens,
      cached: this.cachedTokens,
      total: this.totalTokens,
    };
  }
}
