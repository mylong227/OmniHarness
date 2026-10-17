import { TOOL_NAMES } from '../../ports/tool/toolNames.ts';
import type {
  ModelOutput,
  ModelPort,
  ModelRequest,
  ModelResponseFormat,
} from '../../ports/model/model.ts';

/** 演示用模型适配器：第一步返回工具调用，后续返回最终文本（无需 API Key）。 */
export class MockModel implements ModelPort {
  /** 适配器名，与端口契约一致：固定为 'mock'。 */
  public readonly name = 'mock';

  /** 已收到的 generate 调用次数（决定首次是否返回工具调用）。 */
  private callCount = 0;

  /** 生成响应。
   * @param request 模型请求（只读末条对话消息判定脚本走向，内容不参与生成）。
   * @returns 首次调用且末条非 system 消息为用户消息时返回 shell 工具调用脚本，否则返回固定的完成文本。
   */
  public async generate(request: ModelRequest): Promise<ModelOutput> {
    this.callCount += 1;
    // 结构化输出（2026-10-11）：声明了 responseFormat 就**不再走工具脚本**——调用方要的是一段
    // 可解析的 JSON，先返回一个 shell 工具调用只会把结构化契约拖到第二轮（且 harness 可能
    // 执行那条命令）。MockModel 必须能离线复现结构化契约，否则该能力在无 API Key 的环境里
    // 无法被端到端验证（本仓 `--mock` 的存在理由正是"零额度试跑"）。
    const structured = MockModel.structuredText(request.responseFormat);
    if (structured !== undefined) {
      return { text: structured };
    }
    if (this.shouldUseTool(request)) {
      return {
        toolCalls: [
          {
            id: 'mock_call_1',
            name: TOOL_NAMES.shell,
            arguments: { command: 'echo OmniHarness运行中' },
          },
        ],
      };
    }
    return { text: '任务完成（模拟模型适配器输出）' };
  }

  /**
   * 按 `responseFormat` 造一段**合法 JSON 文本**（确定性，无随机源）。
   *
   * 形状规则：json-schema 档按 `properties` 的类型给占位值、`required` 全部填上；
   * json-object 档给 `{"mock":true}`；text / 缺省返回 `undefined`（走原有脚本）。
   * @param format 请求侧结构化意图。
   * @returns JSON 文本；非结构化时为 `undefined`。
   */
  private static structuredText(format?: ModelResponseFormat): string | undefined {
    if (format === undefined || format.kind === 'text') return undefined;
    if (format.kind === 'json-object') return JSON.stringify({ mock: true });
    const properties = format.schema['properties'];
    const required = format.schema['required'];
    const out: Record<string, unknown> = {};
    if (properties !== null && typeof properties === 'object') {
      const names =
        Array.isArray(required) && required.length > 0
          ? required.map((name) => String(name))
          : Object.keys(properties as Record<string, unknown>);
      for (const name of names) {
        const spec = (properties as Record<string, unknown>)[name];
        out[name] = MockModel.placeholder(spec);
      }
    }
    return JSON.stringify(out);
  }

  /**
   * 按 JSON Schema 片段给一个类型相符的占位值。
   *
   * @param spec 字段的 schema 片段（可能缺失/非对象）。
   * @returns 占位值（`string`/`number`/`boolean`/`array`/`object`，未知类型给 `null`）。
   */
  private static placeholder(spec: unknown): unknown {
    const type =
      spec !== null && typeof spec === 'object' ? (spec as { type?: unknown }).type : undefined;
    switch (type) {
      case 'string':
        return 'mock';
      case 'number':
      case 'integer':
        return 0;
      case 'boolean':
        return false;
      case 'array':
        return [];
      case 'object':
        return {};
      default:
        return null;
    }
  }

  /** 首次请求且末条**非 system** 消息为用户消息时返回工具调用。
   *
   *  为什么忽略尾部的 system 消息：宿主的动态段（repo-map / 项目指令）会被注入成**尾部**
   *  system 消息（为前缀缓存命中而刻意置于尾部）。若按「最后一条消息必须是 user」判定，
   *  这些注入会让第一回合直接跳到「最终文本」，工具回路在真实装配下**根本走不到**
   *  （`npm run smoke` 的 A 段就是这么被证伪的：步数 1 而非 ≥2）。
   * @param request 模型请求。
   * @returns true 表示本次应输出工具调用（演示工具回路）；false 表示输出最终文本。
   */
  private shouldUseTool(request: ModelRequest): boolean {
    if (this.callCount !== 1) {
      return false;
    }
    const conversational = [...request.messages]
      .reverse()
      .find((message) => message.role !== 'system');
    return conversational !== undefined && conversational.role === 'user';
  }
}
