import { log } from '../../util/logger.ts';

/**
 * 模型工具参数的 JSON 解析器（wire → 对象）。
 *
 * 两个模型适配器（OpenAI 兼容 / Ollama）拿到工具参数的方式不同（字符串 vs 分片累积），
 * 但「JSON 非法时回退 `{}` 且必须留 warn」的裁决面相同。抽到一处，避免只有一边补了审计 D5
 * 的留痕、另一边又退回静默空参数。
 */
export class ToolArgumentParser {
  /**
   * 解析工具参数 JSON；非法或非对象时回退空对象（不抛错，保证流不中断）。
   * @param raw wire 层返回的参数 JSON 字符串
   * @returns 解析出的参数对象；JSON 非法或不是对象时返回空对象
   */
  public static parse(raw: string): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      // 静默 {} 会让工具带空参数执行且根因不可归因（审计 D5），必须留痕。
      log.warn('model.tool_arguments.invalid_json', {
        raw: raw.slice(0, 200),
        rawLength: raw.length,
      });
      return {};
    }
  }
}
