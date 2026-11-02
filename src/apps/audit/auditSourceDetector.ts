import { AuditValues } from './auditValues.ts';
import type { AuditSourceFormat } from './auditTypes.ts';

/**
 * 会话来源识别（只看**结构**，不看文件名）。
 *
 * 为什么按结构而不是按路径：审计的对象是"拿到的文件"，不是"它应该在哪"；用户把
 * Claude Code transcript 改名成 `session.jsonl` 也该能读。反过来，路径规则会让
 * "看起来对、实际是别的格式"静默产出空报告——比明确拒绝更糟。
 *
 * 识别顺序有理由：ACP 的 JSON-RPC 特征最独特；Codex 有 `response_item` / `event_msg`
 * 这类独有类型；最后才在 Omni 与 Claude Code 之间按 `payload` / `message` 区分
 * （两者都有 `user` / `assistant` / `system` 类型名）。
 */
export class AuditSourceDetector {
  /** 采样行数上限（识别只需看开头，避免为 60 MB 文件全量解析两遍）。 */
  public static readonly SAMPLE_LINES = 60;

  /** Codex 独有的顶层类型。 */
  private static readonly CODEX_TYPES = ['response_item', 'event_msg', 'turn_context', 'compacted'];

  /** OmniHarness 的事件类型（与 `EventType` 同口径）。 */
  private static readonly OMNI_TYPES = [
    'user',
    'assistant',
    'reasoning',
    'tool_call',
    'tool_result',
    'system',
    'todo',
    'plan',
    'question',
    'turn_diff',
    'model',
    'session_meta',
  ];

  /**
   * 识别格式。
   * @param text 文件全文（只读开头若干行）。
   * @returns 格式；认不出返回 null。
   */
  public detect(text: string): AuditSourceFormat | null {
    const envelope = this.envelopeOf(text);
    if (envelope !== null) {
      return 'omni';
    }
    for (const line of this.sample(text)) {
      const format = this.detectLine(line);
      if (format !== null) {
        return format;
      }
    }
    return null;
  }

  /**
   * 识别 `session export` 的信封形态（单对象 `events[]`）。
   * @param text 文件全文。
   * @returns 信封对象；不是信封返回 null。
   */
  private envelopeOf(text: string): Record<string, unknown> | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith('{')) {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const record = AuditValues.record(parsed);
      return record !== null && record['format'] === 'omniharness.session.v1' ? record : null;
    } catch {
      return null;
    }
  }

  /**
   * 逐行判断（第一个命中即返回）。
   * @param line 行对象。
   * @returns 格式或 null。
   */
  private detectLine(line: Record<string, unknown>): AuditSourceFormat | null {
    const wrapped =
      AuditValues.record(line['message']) ?? AuditValues.record(line['frame']) ?? line;
    const method = AuditValues.stringField(wrapped, 'method');
    if (
      AuditValues.stringField(line, 'jsonrpc') === '2.0' ||
      (method !== null && method.startsWith('session/'))
    ) {
      return 'acp';
    }
    const type = AuditValues.stringField(line, 'type');
    if (type === null) {
      return null;
    }
    const payload = AuditValues.record(line['payload']);
    if (AuditSourceDetector.CODEX_TYPES.indexOf(type) >= 0) {
      return 'codex';
    }
    if (type === 'session_meta' && payload !== null) {
      if (payload['cli_version'] !== undefined || payload['id'] !== undefined) {
        return 'codex';
      }
      if (payload['workspace'] !== undefined || payload['model'] !== undefined) {
        return 'omni';
      }
    }
    if (type === 'summary' && AuditValues.stringField(line, 'summary') !== null) {
      return 'claude-code';
    }
    if (AuditValues.record(line['message']) !== null) {
      return 'claude-code';
    }
    if (payload !== null && AuditSourceDetector.OMNI_TYPES.indexOf(type) >= 0) {
      return 'omni';
    }
    return null;
  }

  /**
   * 读取开头若干条 JSON 行。
   * @param text 文件全文。
   * @returns 解析成功的行对象。
   */
  private sample(text: string): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '') {
        continue;
      }
      try {
        const parsed: unknown = JSON.parse(trimmed);
        const record = AuditValues.record(parsed);
        if (record !== null) {
          out.push(record);
        }
      } catch {
        // 坏行不参与识别（与 AuditJsonl 的容错口径一致）。
      }
      if (out.length >= AuditSourceDetector.SAMPLE_LINES) {
        break;
      }
    }
    return out;
  }
}
