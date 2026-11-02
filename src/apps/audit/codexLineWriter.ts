import { AuditToolPaths } from './auditToolPaths.ts';
import { AuditValues } from './auditValues.ts';
import type { AuditRecordDraft } from './auditTypes.ts';
import type { CodexParseContext } from './codexParseContext.ts';

/**
 * Codex rollout 的**两类载荷写入器**（`response_item` 与 `event_msg`）。
 *
 * 从 `CodexSessionParser` 抽出来是为了两件事：
 * 1. 解析器只做"读行 → 分发 → 汇总"，方法数降到 25 以下（`auditStandards` 的上帝类判据）；
 * 2. 两条支路的去重口径集中在 {@link CodexLineWriter.pushToolCall} 与
 *    `seenCalls` 上，避免两处各写一份"是否已记录"的判断。
 */
export class CodexLineWriter {
  /**
   * 读取 `response_item`。
   * @param context 共享上下文。
   * @param payload 载荷。
   * @param ts 时间戳。
   * @returns 无返回值。
   */
  public static read(
    context: CodexParseContext,
    payload: Record<string, unknown>,
    ts: string | null,
  ): void {
    const type = AuditValues.stringField(payload, 'type');
    switch (type) {
      case 'message':
        CodexLineWriter.readMessage(context, payload, ts);
        return;
      case 'reasoning':
        CodexLineWriter.readReasoning(context, payload, ts);
        return;
      case 'function_call':
        CodexLineWriter.readFunctionCall(context, payload, ts);
        return;
      case 'function_call_output':
      case 'custom_tool_call_output':
        CodexLineWriter.readFunctionOutput(context, payload, ts);
        return;
      case 'local_shell_call':
        CodexLineWriter.readShellCall(context, payload, ts);
        return;
      case 'custom_tool_call':
        CodexLineWriter.readCustomToolCall(context, payload, ts);
        return;
      default:
        CodexLineWriter.push(
          context,
          'other',
          type ?? 'response_item',
          AuditValues.describe(payload),
          ts,
        );
        return;
    }
  }

  /**
   * 读取 `event_msg`。
   * @param context 共享上下文。
   * @param payload 载荷。
   * @param ts 时间戳。
   * @returns 无返回值。
   */
  public static readEvent(
    context: CodexParseContext,
    payload: Record<string, unknown>,
    ts: string | null,
  ): void {
    const type = AuditValues.stringField(payload, 'type');
    switch (type) {
      case 'user_message':
        CodexLineWriter.readFallbackMessage(context, 'user', payload, ts);
        return;
      case 'agent_message':
        CodexLineWriter.readFallbackMessage(context, 'assistant', payload, ts);
        return;
      case 'agent_reasoning':
        CodexLineWriter.readFallbackReasoning(context, payload, ts);
        return;
      case 'token_count':
        CodexLineWriter.readTokenCount(context, payload);
        return;
      case 'exec_command_begin':
        CodexLineWriter.readExecBegin(context, payload, ts);
        return;
      case 'exec_command_end':
        CodexLineWriter.readExecEnd(context, payload, ts);
        return;
      default:
        return;
    }
  }

  /**
   * 读取 message（user / assistant）。
   * @param context 共享上下文。
   * @param payload 载荷。
   * @param ts 时间戳。
   * @returns 无返回值。
   */
  private static readMessage(
    context: CodexParseContext,
    payload: Record<string, unknown>,
    ts: string | null,
  ): void {
    const role = AuditValues.stringField(payload, 'role') ?? 'unknown';
    const text = AuditValues.text(payload['content']) ?? '';
    if (text === '') {
      return;
    }
    const kind = role === 'assistant' ? 'assistant' : role === 'user' ? 'user' : 'other';
    const title = role === 'assistant' ? '助手回复' : role === 'user' ? '用户消息' : role;
    CodexLineWriter.push(context, kind, title, text, ts);
  }

  /**
   * 读取 reasoning（summary 块）。
   * @param context 共享上下文。
   * @param payload 载荷。
   * @param ts 时间戳。
   * @returns 无返回值。
   */
  private static readReasoning(
    context: CodexParseContext,
    payload: Record<string, unknown>,
    ts: string | null,
  ): void {
    const text = AuditValues.text(payload['summary']) ?? AuditValues.text(payload['content']) ?? '';
    if (text !== '') {
      CodexLineWriter.push(context, 'reasoning', '思考', text, ts);
    }
  }

  /**
   * 读取 function_call。
   * @param context 共享上下文。
   * @param payload 载荷。
   * @param ts 时间戳。
   * @returns 无返回值。
   */
  private static readFunctionCall(
    context: CodexParseContext,
    payload: Record<string, unknown>,
    ts: string | null,
  ): void {
    const name = AuditValues.stringField(payload, 'name') ?? 'unknown';
    const args = CodexLineWriter.parseArguments(payload['arguments']);
    const files = AuditToolPaths.fromToolCall(name, args);
    const callId = AuditValues.stringField(payload, 'call_id');
    if (callId !== null) {
      context.seenCalls.add(callId);
    }
    CodexLineWriter.pushToolCall(context, name, AuditValues.describe(args), files, callId, ts);
  }

  /**
   * 读取 function_call_output / custom_tool_call_output。
   * @param context 共享上下文。
   * @param payload 载荷。
   * @param ts 时间戳。
   * @returns 无返回值。
   */
  private static readFunctionOutput(
    context: CodexParseContext,
    payload: Record<string, unknown>,
    ts: string | null,
  ): void {
    const callId = AuditValues.stringField(payload, 'call_id');
    const success = AuditValues.boolField(payload, 'success');
    const status = success === null ? 'pending' : success ? 'ok' : 'error';
    const text = AuditValues.text(payload['output']) ?? AuditValues.describe(payload);
    context.records.push({
      ts,
      kind: 'tool_result',
      title: status === 'error' ? '工具失败' : '工具结果',
      text: AuditValues.truncate(text),
      ...(callId !== null ? { callId } : {}),
      status,
    });
  }

  /**
   * 读取 local_shell_call。
   * @param context 共享上下文。
   * @param payload 载荷。
   * @param ts 时间戳。
   * @returns 无返回值。
   */
  private static readShellCall(
    context: CodexParseContext,
    payload: Record<string, unknown>,
    ts: string | null,
  ): void {
    const callId = AuditValues.stringField(payload, 'call_id');
    if (callId !== null) {
      context.seenCalls.add(callId);
    }
    const action = AuditValues.record(payload['action']);
    const command = action === null ? [] : AuditValues.array(action['command']);
    const text = command.map((item) => String(item)).join(' ');
    const status = AuditValues.stringField(payload, 'status');
    CodexLineWriter.pushToolCall(
      context,
      'shell',
      text === '' ? AuditValues.describe(payload) : text,
      [],
      callId,
      ts,
      status === 'failed' ? 'error' : status === 'completed' ? 'ok' : 'pending',
    );
  }

  /**
   * 读取 custom_tool_call（apply_patch 等）。
   * @param context 共享上下文。
   * @param payload 载荷。
   * @param ts 时间戳。
   * @returns 无返回值。
   */
  private static readCustomToolCall(
    context: CodexParseContext,
    payload: Record<string, unknown>,
    ts: string | null,
  ): void {
    const name = AuditValues.stringField(payload, 'name') ?? 'custom_tool';
    const input = typeof payload['input'] === 'string' ? payload['input'] : '';
    const files = AuditToolPaths.fromPatch(input);
    const callId = AuditValues.stringField(payload, 'call_id');
    if (callId !== null) {
      context.seenCalls.add(callId);
    }
    CodexLineWriter.pushToolCall(context, name, input, files, callId, ts);
  }

  /**
   * event_msg 文本消息（仅当没有 response_item 消息时）。
   * @param context 共享上下文。
   * @param role 角色。
   * @param payload 载荷。
   * @param ts 时间戳。
   * @returns 无返回值。
   */
  private static readFallbackMessage(
    context: CodexParseContext,
    role: string,
    payload: Record<string, unknown>,
    ts: string | null,
  ): void {
    if (context.hasResponseMessages) {
      return;
    }
    const text = AuditValues.stringField(payload, 'message');
    if (text !== null) {
      CodexLineWriter.push(
        context,
        role === 'assistant' ? 'assistant' : 'user',
        role === 'assistant' ? '助手回复' : '用户消息',
        text,
        ts,
      );
    }
  }

  /**
   * event_msg 的 reasoning（仅当没有 response_item 消息时）。
   * @param context 共享上下文。
   * @param payload 载荷。
   * @param ts 时间戳。
   * @returns 无返回值。
   */
  private static readFallbackReasoning(
    context: CodexParseContext,
    payload: Record<string, unknown>,
    ts: string | null,
  ): void {
    if (context.hasResponseMessages) {
      return;
    }
    const text = AuditValues.stringField(payload, 'text');
    if (text !== null) {
      CodexLineWriter.push(context, 'reasoning', '思考', text, ts);
    }
  }

  /**
   * 读取 token_count（累计值，取最后一次）。
   * @param context 共享上下文。
   * @param payload 载荷。
   * @returns 无返回值。
   */
  private static readTokenCount(
    context: CodexParseContext,
    payload: Record<string, unknown>,
  ): void {
    const info = AuditValues.record(payload['info']);
    const usage = info === null ? null : AuditValues.record(info['total_token_usage']);
    if (usage === null) {
      return;
    }
    const input = AuditValues.numberField(usage, 'input_tokens') ?? 0;
    const output = AuditValues.numberField(usage, 'output_tokens') ?? 0;
    const cached = AuditValues.numberField(usage, 'cached_input_tokens') ?? 0;
    context.tokens.sawUsage = true;
    context.tokens.prompt = input;
    context.tokens.completion = output;
    context.tokens.cached = cached;
    context.tokens.total = AuditValues.numberField(usage, 'total_tokens') ?? input + output;
  }

  /**
   * 读取 exec_command_begin（仅当该 call 未在 response_item 出现过）。
   * @param context 共享上下文。
   * @param payload 载荷。
   * @param ts 时间戳。
   * @returns 无返回值。
   */
  private static readExecBegin(
    context: CodexParseContext,
    payload: Record<string, unknown>,
    ts: string | null,
  ): void {
    const callId = AuditValues.stringField(payload, 'call_id');
    if (callId !== null && context.seenCalls.has(callId)) {
      return;
    }
    const command = AuditValues.array(payload['command'])
      .map((item) => String(item))
      .join(' ');
    CodexLineWriter.pushToolCall(context, 'shell', command, [], callId, ts);
  }

  /**
   * 读取 exec_command_end（仅当该 call 未在 response_item 出现过）。
   * @param context 共享上下文。
   * @param payload 载荷。
   * @param ts 时间戳。
   * @returns 无返回值。
   */
  private static readExecEnd(
    context: CodexParseContext,
    payload: Record<string, unknown>,
    ts: string | null,
  ): void {
    const callId = AuditValues.stringField(payload, 'call_id');
    if (callId !== null && context.seenCalls.has(callId)) {
      return;
    }
    const exitCode = AuditValues.numberField(payload, 'exit_code');
    const status = exitCode === null ? 'pending' : exitCode === 0 ? 'ok' : 'error';
    const output =
      AuditValues.stringField(payload, 'stdout') ??
      AuditValues.stringField(payload, 'stderr') ??
      AuditValues.describe(payload);
    context.records.push({
      ts,
      kind: 'tool_result',
      title: status === 'error' ? '工具失败' : '工具结果',
      text: AuditValues.truncate(output),
      ...(callId !== null ? { callId } : {}),
      status,
    });
  }

  /**
   * 追加一条工具调用记录。
   * @param context 共享上下文。
   * @param name 工具名。
   * @param text 参数正文。
   * @param files 触及的文件。
   * @param callId 调用 id。
   * @param ts 时间戳。
   * @param status 结局（缺省 pending）。
   * @returns 无返回值。
   */
  private static pushToolCall(
    context: CodexParseContext,
    name: string,
    text: string,
    files: readonly string[],
    callId: string | null,
    ts: string | null,
    status: 'ok' | 'error' | 'pending' = 'pending',
  ): void {
    context.records.push({
      ts,
      kind: 'tool_call',
      title: name,
      text: AuditValues.truncate(text),
      tool: name,
      ...(callId !== null ? { callId } : {}),
      status,
      ...(files.length > 0 ? { files } : {}),
    });
  }

  /**
   * 追加一条纯文本记录。
   * @param context 共享上下文。
   * @param kind 类别。
   * @param title 标题。
   * @param text 正文。
   * @param ts 时间戳。
   * @returns 无返回值。
   */
  private static push(
    context: CodexParseContext,
    kind: AuditRecordDraft['kind'],
    title: string,
    text: string,
    ts: string | null,
  ): void {
    context.records.push({ ts, kind, title, text: AuditValues.truncate(text) });
  }

  /**
   * 解析 `arguments`（JSON 字符串）。
   * @param value 原始值。
   * @returns 参数对象；无法解析返回 null。
   */
  private static parseArguments(value: unknown): Record<string, unknown> | null {
    if (typeof value !== 'string') {
      return AuditValues.record(value);
    }
    try {
      return AuditValues.record(JSON.parse(value));
    } catch {
      return null;
    }
  }
}
