/**
 * 厂商连通探测与运行时模型构造（#模型接入页）。
 * probe：拿配置好的 Key 真实请求厂商 /models 端点（不可用时回退 1-token chat 探测），
 * 返回实测连通状态与真实模型清单——「有 Key 支持接多少显示多少」的数据来源。
 */
import type { ModelPort } from '../../ports/model/model.js';
import { modelAdapterRegistry } from '../../adapters/model/modelAdapterRegistry.js';
import { ConfigError } from '../../config/configError.js';
import type { ProviderPreset } from './providerPresets.js';
import { SsrfGuard } from '../../security/ssrfGuard.js';
import type { SsrfPolicy } from '../../security/ssrfPolicy.js';
import { Retry } from '../../util/retry.js';

/**
 * ProviderProbe 相关纯函数工具（C7 收口：原顶层内部函数迁入）。
 */
export class ProviderProbe {
  /**
   * 带 Key 请求厂商 /models 端点，返回模型 ID 清单（端点不存在返回 undefined）。
   * @param preset ProviderPreset
   * @param key string | undefined
   * @param ssrfPolicy 已解析的 SSRF 策略表（缺省用内置默认档；由持有活动配置的调用点注入）
   * @returns Promise<string[] | undefined>
   */
  public static async fetchModelsEndpoint(
    preset: ProviderPreset,
    key: string | undefined,
    ssrfPolicy?: SsrfPolicy,
  ): Promise<string[] | undefined> {
    const url =
      preset.adapter === 'anthropic' ? `${preset.baseUrl}/v1/models` : `${preset.baseUrl}/models`;
    const headers: Record<string, string> =
      preset.adapter === 'anthropic'
        ? { 'x-api-key': key ?? '', 'anthropic-version': '2023-06-01' }
        : key !== undefined
          ? { authorization: `Bearer ${key}` }
          : {};
    // SSRF 拦截：baseUrl 可由配置注入，必须先校验再发请求。
    // 策略表随活动配置注入（放行私有网段以兼容本地 Ollama 等场景，但云元数据地址一律拦截，
    // 且用户配置的 `ssrfPolicy` 在此同样生效——此前写死默认档 ⇒ 配了不生效）。
    await SsrfGuard.assertNotSsrf(url, SsrfGuard.ssrfOptionsFor(ssrfPolicy));
    let response: Response;
    try {
      response = await fetch(url, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    } catch (error) {
      throw new Error(`网络不可达：${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(`鉴权失败（HTTP ${response.status}，Key 无效或无权限）`);
    }
    if (!response.ok) {
      return undefined; // 端点不存在/限流等 → 交由 chat 探测兜底
    }
    const body = (await response.json().catch(() => undefined)) as
      { data?: readonly { id?: unknown }[] } | undefined;
    const ids = (body?.data ?? [])
      .map((entry) => (typeof entry?.id === 'string' ? entry.id : undefined))
      .filter((id): id is string => id !== undefined);
    return ids.length > 0 ? ids.slice(0, 60) : undefined;
  }
  /**
   * 回退探测：1-token chat 请求（部分厂商无 /models 端点）。
   * @param preset ProviderPreset
   * @param key string | undefined
   * @param ssrfPolicy 已解析的 SSRF 策略表（缺省用内置默认档；与 /models 探测同一份）
   * @returns Promise<void>
   */
  public static async probeViaChat(
    preset: ProviderPreset,
    key: string | undefined,
    ssrfPolicy?: SsrfPolicy,
  ): Promise<void> {
    const url =
      preset.adapter === 'anthropic'
        ? `${preset.baseUrl}/v1/messages`
        : `${preset.baseUrl}/chat/completions`;
    const headers: Record<string, string> =
      preset.adapter === 'anthropic'
        ? {
            'x-api-key': key ?? '',
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          }
        : { authorization: `Bearer ${key ?? ''}`, 'content-type': 'application/json' };
    const body =
      preset.adapter === 'anthropic'
        ? {
            model: preset.defaultModel,
            max_tokens: 1,
            messages: [{ role: 'user', content: 'ping' }],
          }
        : {
            model: preset.defaultModel,
            max_tokens: 1,
            messages: [{ role: 'user', content: 'ping' }],
          };
    // SSRF 拦截：baseUrl 可由配置注入，必须先校验再发请求（策略表同 /models 探测）。
    await SsrfGuard.assertNotSsrf(url, SsrfGuard.ssrfOptionsFor(ssrfPolicy));
    let response: Response;
    try {
      // 集中重试：网络抖动/5xx 可重试；4xx（含鉴权失败）判定为不可重试，立即失败。
      response = await Retry.withRetry(
        () =>
          fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
          }),
        {
          maxAttempts: 3,
          baseDelayMs: 200,
          isRetryable: (error) =>
            error instanceof Error && /network|fetch failed|timeout|5\d\d/i.test(error.message),
        },
      );
    } catch (error) {
      throw new Error(`网络不可达：${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) {
      throw new Error(`chat 探测失败（HTTP ${response.status}）`);
    }
  }

  /** 构造某厂商的模型适配器（运行时启用厂商用；Key 缺失 fail-closed 抛错）。 */
  public static buildModelForProvider(
    preset: ProviderPreset,
    apiKey: string | undefined,
    model: string | undefined,
  ): ModelPort {
    const pickedModel = model || preset.defaultModel;
    if (preset.needsKey && (apiKey === undefined || apiKey.length === 0)) {
      throw new ConfigError(`厂商 ${preset.label} 未配置 API Key，无法启用（fail-closed）`);
    }
    // 适配器名 → 构造器走一张表（`adapters/model/modelAdapterRegistry.ts`）：此前本函数自带
    // `if (preset.adapter === 'anthropic') …` 分支，与 cliBuildConfig.buildModel / configBuilder
    // 各写一遍（审计 §3.4）。此处只需把厂商预设端点与 Key 交给表。
    const spec = modelAdapterRegistry.get(preset.adapter);
    if (spec === undefined) {
      throw new ConfigError(
        `厂商 ${preset.label} 的 adapter "${preset.adapter}" 未登记于模型适配器注册表`,
      );
    }
    return spec.create({ baseUrl: preset.baseUrl, apiKey: apiKey ?? '', model: pickedModel });
  }

  /**
   * 探测单个厂商：已配 Key 才发起真实请求，返回实测模型清单或可读失败原因。
   * @param preset 目标厂商预设
   * @param key 该厂商 API Key（免 Key 厂商可为 undefined）
   * @param ssrfPolicy 已解析的 SSRF 策略表（缺省内置默认档；调用方持活动配置时应显式注入）
   * @returns 探测结果（凭据绝不回传，仅打码状态）
   */
  public static async probeProvider(
    preset: ProviderPreset,
    key: string | undefined,
    ssrfPolicy?: SsrfPolicy,
  ): Promise<ProviderProbeResult> {
    const base: Omit<ProviderProbeResult, 'ok' | 'models' | 'source' | 'error'> = {
      id: preset.id,
      label: preset.label,
      configured: !preset.needsKey || (key !== undefined && key.length > 0),
    };
    if (!base.configured) {
      return { ...base, ok: false, models: preset.models, source: 'none', error: '未配置 API Key' };
    }
    try {
      const ids = await ProviderProbe.fetchModelsEndpoint(
        preset,
        preset.needsKey ? key : undefined,
        ssrfPolicy,
      );
      if (ids !== undefined) {
        return { ...base, ok: true, models: ids, source: 'models-endpoint' };
      }
      await ProviderProbe.probeViaChat(preset, preset.needsKey ? key : undefined, ssrfPolicy);
      return { ...base, ok: true, models: preset.models, source: 'chat-probe' };
    } catch (error) {
      return {
        ...base,
        ok: false,
        models: preset.models,
        source: 'none',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

/** 单个厂商的探测结果（凭据绝不回传，仅打码状态）。 */
export interface ProviderProbeResult {
  readonly id: string;
  readonly label: string;
  /** 是否已配置 Key（免 Key 厂商恒 true）。 */
  readonly configured: boolean;
  /** 实测是否可连通。 */
  readonly ok: boolean;
  /** 实测拿到的模型清单（/models 成功时为真实清单，否则为预设兜底清单）。 */
  readonly models: readonly string[];
  /** 实测来源：models 端点 / chat 探测 / 预设清单。 */
  readonly source: 'models-endpoint' | 'chat-probe' | 'preset' | 'none';
  /** 失败原因（ok=false 时可读）。 */
  readonly error?: string;
}

const PROBE_TIMEOUT_MS = 10_000;
