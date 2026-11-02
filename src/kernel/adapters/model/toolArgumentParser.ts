import { log } from '../../util/logger.ts';

/** 参数解析结果（`error` 非空表示不可修复，调用方必须 fail-closed）。 */
export interface ParsedToolArguments {
  /** 解析出的参数对象；不可修复时为空对象。 */
  readonly arguments: Record<string, unknown>;
  /** 不可修复的错误说明；可修复或本来合法时为 undefined。 */
  readonly error?: string | undefined;
  /** 是否经过了修复（观测用）。 */
  readonly repaired?: boolean | undefined;
}

/**
 * 模型工具参数的 JSON 解析器（wire → 对象）。
 *
 * 两个模型适配器（OpenAI 兼容 / Ollama）拿到工具参数的方式不同（字符串 vs 分片累积），
 * 但「JSON 非法时如何裁决」的语义必须相同。抽到一处，避免只有一边补了审计 D5
 * 的留痕、另一边又退回静默空参数。
 *
 * 2026-10-28：非法 JSON 不再静默回退 `{}` 后照常执行——先做**确定性修复**（围栏/尾逗号/
 * 未闭合字符串与括号），修不好则把 `error` 交给 `ToolCall.parseError`，由执行器 fail-closed
 * 拒绝并在工具结果里给出可行动原因。空参数执行写类工具是比"报错"危险得多的失败方向。
 */
export class ToolArgumentParser {
  /**
   * 解析工具参数 JSON；非法时尝试修复，仍失败则返回空对象（不抛错，保证流不中断）。
   * @param raw wire 层返回的参数 JSON 字符串
   * @returns 解析出的参数对象；JSON 非法或不是对象时返回空对象
   */
  public static parse(raw: string): Record<string, unknown> {
    return ToolArgumentParser.parseDetailed(raw).arguments;
  }

  /**
   * 解析并给出诊断：合法 → `{arguments}`；可修复 → `{arguments, repaired:true}`；
   * 不可修复 → `{arguments:{}, error}`。
   * @param raw wire 层参数 JSON 字符串。
   * @returns 解析结果与诊断。
   */
  public static parseDetailed(raw: string): ParsedToolArguments {
    const direct = ToolArgumentParser.asObject(raw);
    if (direct !== undefined) {
      return { arguments: direct };
    }
    const repairedText = ToolArgumentParser.repair(raw);
    const repaired = repairedText === raw ? undefined : ToolArgumentParser.asObject(repairedText);
    if (repaired !== undefined) {
      log.info('model.tool_arguments.repaired', {
        raw: raw.slice(0, 200),
        rawLength: raw.length,
      });
      return { arguments: repaired, repaired: true };
    }
    // 静默 {} 会让工具带空参数执行且根因不可归因（审计 D5），必须留痕并交给执行器拒绝。
    log.warn('model.tool_arguments.invalid_json', {
      raw: raw.slice(0, 200),
      rawLength: raw.length,
    });
    return {
      arguments: {},
      error: `工具参数不是合法 JSON（长度 ${String(raw.length)}）；原始片段：${raw.slice(0, 160)}`,
    };
  }

  /**
   * 尝试把文本解析为「非数组对象」。
   * @param text JSON 文本。
   * @returns 对象；非法/非对象时为 undefined。
   */
  private static asObject(text: string): Record<string, unknown> | undefined {
    try {
      const parsed: unknown = JSON.parse(text);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 确定性修复常见 wire 畸形：
   *  - Markdown 代码围栏；
   *  - 单引号（仅当全文没有双引号）；
   *  - 尾逗号；
   *  - 被截断的字符串 / 对象 / 数组（补引号与闭合括号）。
   * @param raw 原始文本。
   * @returns 修复后的文本（可能仍非法）。
   */
  private static repair(raw: string): string {
    let text = raw.trim();
    text = text
      .replace(/^```(?:json)?\s*/iu, '')
      .replace(/```$/u, '')
      .trim();
    if (text === '') return text;
    // 只在完全没有双引号时把单引号转双引号，避免破坏合法字符串里的撇号。
    if (!text.includes('"')) text = text.replace(/'/gu, '"');
    text = text.replace(/,\s*([}\]])/gu, '$1').replace(/,\s*$/u, '');
    return ToolArgumentParser.closeUnbalanced(text);
  }

  /**
   * 补全未闭合的字符串与括号（简单栈，不处理转义外的语义修复）。
   * @param text 待补全文本。
   * @returns 补全后的文本。
   */
  private static closeUnbalanced(text: string): string {
    const stack: string[] = [];
    let inString = false;
    let escaped = false;
    for (const char of text) {
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') stack.push('}');
      else if (char === '[') stack.push(']');
      else if (char === '}' || char === ']') stack.pop();
    }
    let out = text;
    if (inString) out += '"';
    while (stack.length > 0) out += stack.pop();
    return out;
  }
}
