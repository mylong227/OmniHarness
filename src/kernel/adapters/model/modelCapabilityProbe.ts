import type { ModelPort } from '../../../contracts/ports/model/model.ts';
import type { ModelToolSpec } from '../../../contracts/ports/model/modelToolSpec.ts';
import { log } from '../../util/logger.ts';

/**
 * 模型**能力探针**（U2-4，2026-10-30）：对当前配置的 ModelPort 跑一组受控小请求，
 * 产出 capability card——「这个端点/适配器组合**真的**支持什么」。
 *
 * ## 为什么需要它
 *
 * 适配器声明支持 ≠ 端点真支持：同一家端点的不同模型对 tool calling / 并行调用 / JSON
 * 模式 / reasoning 档位的支持参差（CORE_CAPABILITY_UPGRADE §3.2①：harness 与模型的配对
 * 会改变失败模式）。与其在配置文档里写「支持」，不如发几条可控小请求**当场量**，
 * 失败模式按能力逐项拆开（而不是笼统的「模型坏了」）。
 *
 * ## 口径（每条探针的判定）
 *
 * - `basic`：普通补全返回非空文本（一切探针的前置）。
 * - `toolCalling`：给一个工具，模型是否真的发出 `tool_calls`（而不是文本描述）。
 * - `parallelTools`：给两个独立工具并明确要求一步全调 ⇒ 一次输出里 ≥2 个调用。
 * - `jsonOutput`：要求纯 JSON ⇒ 输出可被 `JSON.parse`（端口级口径，不依赖厂商 JSON 模式）。
 * - `reasoningEffort`：带 `reasoningEffort` 的请求**不报错**（端口级只能量「接受」，
 *   实际档位效果是适配器级测试的职责——`modelAdapters.test.ts` 的 wire 断言）。
 * - `streaming`：`stream()` 存在时走流式并拼回非空文本；端口无 `stream` ⇒ `unsupported`。
 *
 * ## 诚实边界
 *
 * - **缓存探测不做**：缓存命中是厂商字段 + 时序行为（两次请求间秒级不保证命中），
 *   端口级探不出可信结论；Anthropic `cache_control` 的 wire 断言已在 `modelAdapters.test.ts`。
 * - 每条探针都是**一次小请求**（maxOutputTokens 钳 200）：探针本身要便宜，别拿它当跑分。
 * - `error` 与 `fail` 分开：前者是请求层异常（网络/鉴权/400），后者是模型行为不符合预期。
 */
export class ModelCapabilityProbe {
  /** 探针请求的输出上限：探测只要「行为」，不要长文。 */
  private static readonly PROBE_MAX_TOKENS = 200;

  /**
   * 跑全量能力探针。
   * @param model 目标模型端口（来自装配后的 ResolvedConfig.model）。
   * @returns 能力卡（逐项状态 + 证据）。
   */
  public static async run(model: ModelPort): Promise<ModelCapabilityCard> {
    const probes: ModelProbeOutcome[] = [];
    probes.push(await ModelCapabilityProbe.probeBasic(model));
    probes.push(await ModelCapabilityProbe.probeToolCalling(model));
    probes.push(await ModelCapabilityProbe.probeParallelTools(model));
    probes.push(await ModelCapabilityProbe.probeJsonOutput(model));
    probes.push(await ModelCapabilityProbe.probeReasoningEffort(model));
    probes.push(await ModelCapabilityProbe.probeStreaming(model));
    const blocking = probes.filter((p) => p.status === 'fail' || p.status === 'error');
    return { model: model.name, probes, ok: blocking.length === 0 };
  }

  /**
   * ① 基础补全。
   * @param model 模型端口。
   * @returns 探针结果。
   */
  private static async probeBasic(model: ModelPort): Promise<ModelProbeOutcome> {
    try {
      const out = await model.generate({
        messages: [{ role: 'user', content: '只回复两个字母：OK' }],
        tools: [],
        role: 'executor',
        maxOutputTokens: ModelCapabilityProbe.PROBE_MAX_TOKENS,
      });
      const text = (out.text ?? '').trim();
      if (text === '') {
        return { id: 'basic', title: '基础补全', status: 'fail', detail: '返回空文本' };
      }
      return {
        id: 'basic',
        title: '基础补全',
        status: 'pass',
        detail: `text=${text.slice(0, 40)}`,
      };
    } catch (error) {
      return {
        id: 'basic',
        title: '基础补全',
        status: 'error',
        detail: ModelCapabilityProbe.messageOf(error),
      };
    }
  }

  /**
   * ② 工具调用。
   * @param model 模型端口。
   * @returns 探针结果。
   */
  private static async probeToolCalling(model: ModelPort): Promise<ModelProbeOutcome> {
    try {
      const out = await model.generate({
        messages: [{ role: 'user', content: '查一下杭州现在的天气。必须调用工具，不要文字回答。' }],
        tools: [ModelCapabilityProbe.weatherTool()],
        role: 'executor',
        maxOutputTokens: ModelCapabilityProbe.PROBE_MAX_TOKENS,
      });
      const called = out.toolCalls?.some((c) => c.name === 'get_weather') ?? false;
      if (!called) {
        return {
          id: 'toolCalling',
          title: '工具调用',
          status: 'fail',
          detail: `未发出 get_weather 调用（text=${(out.text ?? '').slice(0, 40)}）`,
        };
      }
      return {
        id: 'toolCalling',
        title: '工具调用',
        status: 'pass',
        detail: '发出 get_weather 调用',
      };
    } catch (error) {
      return {
        id: 'toolCalling',
        title: '工具调用',
        status: 'error',
        detail: ModelCapabilityProbe.messageOf(error),
      };
    }
  }

  /**
   * ③ 并行工具调用（一次输出 ≥2 个调用）。
   * @param model 模型端口。
   * @returns 探针结果。
   */
  private static async probeParallelTools(model: ModelPort): Promise<ModelProbeOutcome> {
    const timeTool: ModelToolSpec = {
      name: 'get_time',
      description: '获取当前时间',
      parameters: { type: 'object', properties: {}, required: [] },
    };
    const dateTool: ModelToolSpec = {
      name: 'get_date',
      description: '获取当前日期',
      parameters: { type: 'object', properties: {}, required: [] },
    };
    try {
      const out = await model.generate({
        messages: [
          {
            role: 'user',
            content:
              '同时查询当前时间和当前日期。这两个查询互不依赖，请在同一次回复里把两个工具都调用。',
          },
        ],
        tools: [timeTool, dateTool],
        role: 'executor',
        maxOutputTokens: ModelCapabilityProbe.PROBE_MAX_TOKENS,
      });
      const calls = out.toolCalls ?? [];
      const names = new Set(calls.map((c) => c.name));
      if (calls.length >= 2 && names.size >= 2) {
        return {
          id: 'parallelTools',
          title: '并行工具调用',
          status: 'pass',
          detail: `一次发出 ${String(calls.length)} 个调用`,
        };
      }
      return {
        id: 'parallelTools',
        title: '并行工具调用',
        status: 'fail',
        detail: `一次只发出 ${String(calls.length)} 个调用（${[...names].join(',') || '无'}）——harness 会退化为串行补调`,
      };
    } catch (error) {
      return {
        id: 'parallelTools',
        title: '并行工具调用',
        status: 'error',
        detail: ModelCapabilityProbe.messageOf(error),
      };
    }
  }

  /**
   * ④ JSON 输出（端口级口径：要求纯 JSON 且可解析）。
   * @param model 模型端口。
   * @returns 探针结果。
   */
  private static async probeJsonOutput(model: ModelPort): Promise<ModelProbeOutcome> {
    try {
      const out = await model.generate({
        messages: [
          {
            role: 'user',
            content: '只输出一个 JSON 对象，不要任何其他文字：{"city":"杭州","ok":true}',
          },
        ],
        tools: [],
        role: 'executor',
        maxOutputTokens: ModelCapabilityProbe.PROBE_MAX_TOKENS,
      });
      const text = (out.text ?? '').trim();
      const stripped = text.replace(/^```(?:json)?\s*/u, '').replace(/```\s*$/u, '');
      try {
        JSON.parse(stripped);
      } catch {
        return {
          id: 'jsonOutput',
          title: 'JSON 输出',
          status: 'fail',
          detail: `输出不可解析：${text.slice(0, 60)}`,
        };
      }
      return {
        id: 'jsonOutput',
        title: 'JSON 输出',
        status: 'pass',
        detail: '输出可被 JSON.parse',
      };
    } catch (error) {
      return {
        id: 'jsonOutput',
        title: 'JSON 输出',
        status: 'error',
        detail: ModelCapabilityProbe.messageOf(error),
      };
    }
  }

  /**
   * ⑤ reasoning 档位接受性（端口级只量「不报错」）。
   * @param model 模型端口。
   * @returns 探针结果。
   */
  private static async probeReasoningEffort(model: ModelPort): Promise<ModelProbeOutcome> {
    try {
      const out = await model.generate({
        messages: [{ role: 'user', content: '只回复：好' }],
        tools: [],
        role: 'executor',
        reasoningEffort: 'low',
        maxOutputTokens: ModelCapabilityProbe.PROBE_MAX_TOKENS,
      });
      if ((out.text ?? '').trim() === '') {
        return {
          id: 'reasoningEffort',
          title: '推理档位',
          status: 'fail',
          detail: '带 reasoningEffort 的请求返回空文本',
        };
      }
      return {
        id: 'reasoningEffort',
        title: '推理档位',
        status: 'pass',
        detail: '带 reasoningEffort 的请求被接受（档位实际效果由适配器级 wire 判据覆盖）',
      };
    } catch (error) {
      return {
        id: 'reasoningEffort',
        title: '推理档位',
        status: 'error',
        detail: ModelCapabilityProbe.messageOf(error),
      };
    }
  }

  /**
   * ⑥ 流式（端口有 `stream` 才测；无 ⇒ unsupported）。
   * @param model 模型端口。
   * @returns 探针结果。
   */
  private static async probeStreaming(model: ModelPort): Promise<ModelProbeOutcome> {
    if (model.stream === undefined) {
      return {
        id: 'streaming',
        title: '流式输出',
        status: 'unsupported',
        detail: '该端口未实现 stream()（同步 generate 路径不受影响）',
      };
    }
    const parts: string[] = [];
    try {
      await model.stream(
        {
          messages: [{ role: 'user', content: '只回复两个字母：OK' }],
          tools: [],
          role: 'executor',
          maxOutputTokens: ModelCapabilityProbe.PROBE_MAX_TOKENS,
        },
        {
          onText: (delta) => parts.push(delta),
        },
      );
    } catch (error) {
      return {
        id: 'streaming',
        title: '流式输出',
        status: 'error',
        detail: ModelCapabilityProbe.messageOf(error),
      };
    }
    const joined = parts.join('');
    if (joined.trim() === '') {
      return { id: 'streaming', title: '流式输出', status: 'fail', detail: '零文本增量' };
    }
    return {
      id: 'streaming',
      title: '流式输出',
      status: 'pass',
      detail: `拼接文本=${joined.slice(0, 40)}`,
    };
  }

  /**
   * 渲染能力卡（CLI 出口；表给人看，JSON 给机器）。
   * @param card 探针能力卡。
   * @param json 为 true 时输出单行 JSON（机器可读），否则输出对齐表格。
   * @returns 完整输出文本（含结尾换行）。
   */
  public static render(card: ModelCapabilityCard, json: boolean): string {
    if (json) {
      return `${JSON.stringify(card)}\n`;
    }
    const lines: string[] = [`模型能力卡：${card.model}`];
    for (const probe of card.probes) {
      const mark =
        probe.status === 'pass'
          ? '✓'
          : probe.status === 'unsupported'
            ? '○'
            : probe.status === 'error'
              ? '✗ error'
              : '✗ fail';
      lines.push(`  ${mark} ${probe.title}：${probe.detail}`);
    }
    lines.push(card.ok ? '结论：无阻断项（ok）' : '结论：存在 fail/error 项（见上）');
    return `${lines.join('\n')}\n`;
  }

  /** 天气工具（②的探针夹具）。
   * @returns 单工具 schema（city 必填）。
   */
  private static weatherTool(): ModelToolSpec {
    return {
      name: 'get_weather',
      description: '查询指定城市的实时天气',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string', description: '城市名' } },
        required: ['city'],
      },
    };
  }

  /** 错误信息压缩成一行（探针 detail 里要可读）。
   * @param error 捕获到的异常。
   * @returns 单行、截到 140 字符的错误描述（并留 debug 轨迹）。
   */
  private static messageOf(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    log.debug('modelProbe.request_failed', { error: raw });
    return raw.replace(/\s+/gu, ' ').slice(0, 140);
  }
}

/** 单条探针结果。 */
export interface ModelProbeOutcome {
  /** 探针 id（机器可读：basic/toolCalling/parallelTools/jsonOutput/reasoningEffort/streaming）。 */
  readonly id: string;
  /** 可读标题。 */
  readonly title: string;
  /** pass=符合预期；fail=模型行为不符；error=请求层异常；unsupported=端口未提供该面。 */
  readonly status: 'pass' | 'fail' | 'error' | 'unsupported';
  /** 证据（一句话）。 */
  readonly detail: string;
}

/** 能力卡：一个端点/适配器组合的探针结论。 */
export interface ModelCapabilityCard {
  /** 端口名（含适配器与模型标识）。 */
  readonly model: string;
  /** 逐项探针结果。 */
  readonly probes: readonly ModelProbeOutcome[];
  /** 无 fail/error 即 true（unsupported 不阻断）。 */
  readonly ok: boolean;
}
