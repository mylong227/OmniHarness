import type { ModelPort } from '../../ports/model/model.js';
import { MODEL_ADAPTER_IDS, type ModelAdapterId } from '../../ports/model/modelAdapterId.js';
import { MockModel } from './mockModel.js';
import { OpenAiCompatibleModel } from './openAiCompatibleModel.js';
import { AnthropicModel } from './anthropicModel.js';
import { ResponsesModel } from './responsesModel.js';
import { LlamaCppModel } from './llamaCppModel.js';

/** 构造一个模型适配器所需的配置（三种 OpenAI 系适配器共用同一形状）。 */
export interface ModelAdapterConfig {
  /** 端点地址。 */
  readonly baseUrl: string;
  /** 模型名。 */
  readonly model: string;
  /** API Key；免 Key 适配器（本地 `llamacpp`）可缺省。 */
  readonly apiKey?: string | undefined;
}

/** 一张表的一行：适配器标识 → 兜底数据来源 + 构造器。 */
export interface ModelAdapterSpec {
  /** 适配器标识（`--model-adapter` / 厂商预设的 `adapter` 取值）。 */
  readonly id: string;
  /**
   * `defaults/endpoints.json` 中 `modelAdapters` 的记录 id（兜底端点 / 兜底模型 / env 名从这里取）。
   * 缺省表示该适配器无兜底数据需求（`mock`）。
   */
  readonly defaultsId?: string;
  /**
   * 构造实例（唯一允许 `new` 各模型适配器的位置）。
   * @param config 端点 / 模型 / Key。
   * @returns 模型端口。
   */
  readonly create: (config: ModelAdapterConfig) => ModelPort;
}

/**
 * 模型适配器注册表（**适配器名 → 构造器的一张表**）。
 *
 * ## 为什么（审计 §3.4「扩展接缝是改一处漏一处」的收口；用户指令）
 *
 * 此前「适配器名 → 具体类」的分支在**三个地方各写一遍**：
 * `cli/cliBuildConfig.buildModel`（4 分支）、`config/configBuilder.buildRouterAdapter`（3 分支）、
 * `server/services/providerProbe.buildModelForProvider`（2 分支）——加一个适配器要同时改三处，
 * 而三处的兜底与报错口径还会各自漂移（同一组端点地址也曾在两处各写一遍，见 `defaults/endpoints.json`）。
 *
 * 现在**构造只在本文件的表里**：消费方一律 `modelAdapterRegistry.get(id)`，未知 id 由调用方决定
 * 是抛错（路由条目/厂商预设）还是退化为 mock（CLI 兜底）。
 *
 * ## 表与其它两处声明的分工（避免第三次漂移）
 *
 * - `cli/cliEnums.MODEL_ADAPTERS`：CLI 解析期的**枚举白名单**（`satisfies CliArgs['modelAdapter'][]`
 *   提供编译期防漂移），本表不再重复该职责；
 * - `config/configError.ENUM_VALUES.modelAdapter`：配置文件校验白名单。
 * - 三者的一致性由 `tests/unit/adapterFactories.test.ts` 机械核对（曾实测 `llamacpp` 只在
 *   `FileConfig` 类型与 CLI 枚举里、**漏在配置校验白名单**中 ⇒ 配置文件写 `llamacpp` 被判非法）。
 *
 * 兜底值（端点 / 模型 / 凭据 env 名）**不在本表**，而在 `defaults/endpoints.json`（改数据不改代码）。
 */
export class ModelAdapterRegistry {
  /** 适配器标识 → 规格。 */
  private readonly specs: ReadonlyMap<string, ModelAdapterSpec>;

  /**
   * @param specs 表的全部行（构造期校验 id 唯一且非空；重复即抛错，避免「后写的静默覆盖先写的」）。
   * @throws Error id 为空或重复时抛出
   */
  public constructor(specs: readonly ModelAdapterSpec[]) {
    const map = new Map<string, ModelAdapterSpec>();
    for (const spec of specs) {
      if (spec.id.trim() === '') {
        throw new Error('模型适配器注册表存在空 id');
      }
      if (map.has(spec.id)) {
        throw new Error(`模型适配器注册表存在重复 id：${spec.id}`);
      }
      map.set(spec.id, spec);
    }
    this.specs = map;
  }

  /**
   * 按适配器标识取规格。
   * @param id 适配器标识。
   * @returns 规格；未登记返回 undefined（由调用方决定抛错还是兜底）。
   */
  public get(id: string): ModelAdapterSpec | undefined {
    return this.specs.get(id);
  }

  /**
   * 全部已登记适配器标识（按登记顺序）。
   * @returns 标识列表。
   */
  public ids(): readonly string[] {
    return [...this.specs.keys()];
  }
}

/**
 * 演示模型适配器标识：既不连端点也不需要凭据，是「未指定适配器」与「未知适配器」的**唯一兜底**。
 * 单独成常量，便于调用点表达「回落 mock」而不必再写一个字面量。
 */
export const MOCK_ADAPTER_ID: ModelAdapterId = 'mock';

/**
 * 表体：适配器标识 → 规格（不含 `id`，由清单注入）。
 *
 * 用 `Record<ModelAdapterId, …>` 表达 ⇒ 与 `ports/model/modelAdapterId.ts` 的清单**编译期锁死**：
 * 清单加了名字却漏加一行、或表里写了清单外的名字，都直接编译报错（不需要运行时校验）。
 */
const ADAPTER_SPECS: Readonly<Record<ModelAdapterId, Omit<ModelAdapterSpec, 'id'>>> = {
  // mock 无 defaultsId：它不连任何端点，构造也不需要配置。
  [MOCK_ADAPTER_ID]: { create: () => new MockModel() },
  openai: {
    defaultsId: 'openai',
    create: (config) =>
      new OpenAiCompatibleModel({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey ?? '',
        model: config.model,
      }),
  },
  anthropic: {
    defaultsId: 'anthropic',
    create: (config) =>
      new AnthropicModel({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey ?? '',
        model: config.model,
      }),
  },
  responses: {
    defaultsId: 'responses',
    create: (config) =>
      new ResponsesModel({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey ?? '',
        model: config.model,
      }),
  },
  llamacpp: {
    defaultsId: 'llamacpp',
    create: (config) =>
      new LlamaCppModel({
        baseUrl: config.baseUrl,
        model: config.model,
        apiKey: config.apiKey,
      }),
  },
};

/**
 * 默认注册表实例：表体由 `MODEL_ADAPTER_IDS`（唯一名字来源）逐项注入 `id`。
 *
 * 顺序即清单顺序（`--help` 与枚举提示的展示顺序）。
 */
export const modelAdapterRegistry = new ModelAdapterRegistry(
  MODEL_ADAPTER_IDS.map((id) => ({ id, ...ADAPTER_SPECS[id] })),
);
