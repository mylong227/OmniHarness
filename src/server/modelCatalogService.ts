import type { FileConfig } from '../config/configFile.js';
import type { ModelPort } from '../ports/model.js';
import { PROVIDER_PRESETS, type ProviderPreset } from './providerPresets.js';
import { probeProvider, buildModelForProvider } from './providerProbe.js';

/** 单厂商实测缓存项。 */
export interface ProviderProbeCacheEntry {
  readonly ok: boolean;
  readonly models: readonly string[];
}

/** 模型目录服务依赖。 */
export interface ModelCatalogDeps {
  /** 生效的文件级配置（含 UI 覆盖）。 */
  readonly fileConfig: () => FileConfig;
  /** UI 覆盖的 modelAdapter（优先于配置文件）。 */
  readonly adapterOverride: () => string | undefined;
}

/**
 * 模型目录 / 厂商探测服务（#模型接入页）：
 *   - `probe`：对 providerKeys 中已配 Key 的厂商与/或指定厂商发起真实 `/models` 请求，
 *     返回实测状态与模型清单，并把结果写入内部 probeCache 供下拉复用。
 *   - `catalog`：返回预设清单 + 当前厂商与其**真实可用**模型（只回实测清单，不回退预设兜底，
 *     避免 UI 展示未经检测的假列表）。
 *   - `resolveOverride`：按 UI 覆盖 / 落盘配置构造运行时模型适配器（Key 缺失 fail-closed）。
 *
 * probeCache 由本类独占持有；外部（配置启用厂商时）经 `cacheProbe` 写入，保证单一写入路径。
 */
export class ModelCatalogService {
  private readonly fileConfig: () => FileConfig;
  private readonly adapterOverride: () => string | undefined;
  /**
   * 探测结果缓存：厂商 id → 实测连通状态与真实模型清单。
   * 「检测」按钮与「启用此厂商」时填充；model.catalog 用它把 Composer 下拉
   * 换成当前厂商真实可用的模型（而非预设兜底清单）。
   */
  private readonly probeCache = new Map<string, ProviderProbeCacheEntry>();

  /**
   * @param deps 配置读取器（生效文件配置 + UI 适配器覆盖）
   */
  public constructor(deps: ModelCatalogDeps) {
    this.fileConfig = deps.fileConfig;
    this.adapterOverride = deps.adapterOverride;
  }

  /**
   * 探测厂商连通性：对指定厂商或全部已配 Key 厂商发起真实 /models 请求。
   * @param params `{ provider?: string }`
   * @returns `{ providers: ProviderProbeResult[] }`
   */
  public async probe(params: Record<string, unknown>): Promise<unknown> {
    const requested = typeof params['provider'] === 'string' ? params['provider'] : undefined;
    const file = this.fileConfig();
    const keys: Record<string, string> = { ...(file.providerKeys ?? {}) };
    const presets = PROVIDER_PRESETS.filter((p) => requested === undefined || p.id === requested);
    const results = [];
    for (const preset of presets) {
      let key = keys[preset.id];
      // 活动厂商走顶层 apiKey（兼容老配置：modelAdapter+apiKey 直配）。
      if (
        key === undefined &&
        preset.needsKey &&
        file.modelAdapter === preset.adapter &&
        typeof file.apiKey === 'string'
      ) {
        key = file.apiKey;
      }
      const probed = await probeProvider(preset, key);
      results.push(probed);
      this.probeCache.set(preset.id, { ok: probed.ok, models: probed.models });
    }
    return { providers: results };
  }

  /**
   * 厂商目录 RPC：返回预设清单（无凭据）+ 当前厂商与其可用模型（UI 模型下拉按此过滤）。
   * 当前厂商判定：baseUrl 精确匹配预设 → 否则按 modelAdapter 匹配的第一个预设。
   * @returns `{ providers: readonly ProviderPreset[]; active?: {...} }`
   */
  public catalog(): unknown {
    const file = this.fileConfig();
    const adapter = this.adapterOverride() ?? file.modelAdapter;
    const active = this.activePreset(file.baseUrl, adapter);
    if (active === undefined) {
      return { providers: PROVIDER_PRESETS, active: undefined };
    }
    const probed = this.probeCache.get(active.id);
    const realModels = probed?.ok === true ? probed.models : [];
    return {
      providers: PROVIDER_PRESETS,
      active: {
        id: active.id,
        label: active.label,
        defaultModel: active.defaultModel,
        model: file.model ?? active.defaultModel,
        // 只返回真实可用模型：有实测缓存用真实清单，否则只保留当前值（不 fallback 到预设兜底）。
        models: Array.from(new Set([file.model ?? '', ...realModels].filter(Boolean))),
        // 推理强度档位（#B6 扩展，2026-09-08）：仅当下拉动态档位可用时下发；
        // undefined 时 UI 退回内置兜底列表（向后兼容）。空数组表示该厂商无 effort 档位。
        reasoningEffort: active.reasoningEffort,
      },
    };
  }

  /**
   * UI 覆盖的运行时模型（agent 重建用）：仅当显式设置了 modelAdapter 时生效。
   * mock 保持启动时模型不动；其余按覆盖字段构造真适配器，Key 缺失 fail-closed 抛可读错误。
   * @returns 模型端口；mock/llamacpp/未配置时为 undefined
   */
  public resolveOverride(): ModelPort | undefined {
    // 适配器来源：UI 覆盖优先，回退落盘配置（修复「serve 以 mock 启动后，配置文件里
    // 已启用真模型但运行时仍用 mock」的断裂——磁盘配置此前只在重启时才被读到）。
    const file = this.fileConfig();
    const adapter = this.adapterOverride() ?? file.modelAdapter;
    if (adapter === undefined || adapter === 'mock' || adapter === 'llamacpp') {
      return undefined;
    }
    const preset = PROVIDER_PRESETS.filter((p) => p.adapter === adapter)[0];
    if (preset === undefined) {
      return undefined;
    }
    const apiKey =
      file.apiKey ??
      file.providerKeys?.[preset.id] ??
      (adapter === 'anthropic' ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY);
    const effectivePreset =
      file.baseUrl !== undefined ? { ...preset, baseUrl: file.baseUrl } : preset;
    return buildModelForProvider(effectivePreset, apiKey ?? undefined, file.model);
  }

  /**
   * 探测单一厂商并把结果写入 probeCache（「启用此厂商」时调用；探测失败不抛错）。
   * @param preset 目标厂商预设
   * @param key 该厂商 API Key（免 Key 厂商可为 undefined）
   */
  public async cacheProbe(preset: ProviderPreset, key: string | undefined): Promise<void> {
    // 启用即实测：探测真实 /models 清单进缓存，Composer 下拉立即显示真实可用模型。
    // 探测失败不阻断启用（fail-open 到预设清单），错误由下次「检测」刷新。
    const probed = await probeProvider(preset, key);
    this.probeCache.set(preset.id, { ok: probed.ok, models: probed.models });
  }

  /** 当前厂商：baseUrl 精确匹配优先，否则 modelAdapter 匹配的第一个预设。 */
  private activePreset(baseUrl: string | undefined, adapter: string | undefined): ProviderPreset | undefined {
    const byUrl = PROVIDER_PRESETS.find((p) => baseUrl !== undefined && baseUrl === p.baseUrl);
    if (byUrl !== undefined) return byUrl;
    return PROVIDER_PRESETS.filter((p) => p.adapter === adapter)[0];
  }
}
