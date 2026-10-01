import type { ProviderAdapterId } from '../model/modelAdapterId.js';

/**
 * 单个大模型厂商预设（配置文件形态，与随包发布的 `defaults/providers.json` 记录**同形**）。
 *
 * 为什么放进配置层：该结构既是**内建目录的数据形状**（由 `defaults/providers.json` 供给），
 * 也是**用户覆盖的形状**（`omniharness.json` 的 `providerPresets`），二者必须同源，
 * 否则「改数据」与「改配置」会出现两套字段口径。
 *
 * 已从 `config/configFile.ts` 外迁到 ports/config：原文件退化为纯再导出桶，调用点零改动。
 */
export interface ProviderPresetConfig {
  /** 厂商标识（稳定 ID，`providerKeys` 的键）。 */
  readonly id: string;
  /** 展示名（UI 厂商卡片标题）。 */
  readonly label: string;
  /** 底层适配器类型（缺省用于模型构造；对应 `FileConfig.modelAdapter`）。 */
  readonly adapter: ProviderAdapterId;
  /**
   * CLI `--model-adapter` 取值中，哪些应解析到本厂商（缺省 `[adapter]`）。
   * 例：OpenAI 同时是 `responses` 通道的预设；Ollama 的 `adapter` 是 `openai`（兼容层），
   * 但 CLI 侧 `--model-adapter llamacpp` 才指向它。
   */
  readonly cliAdapters?: readonly string[];
  /** 默认端点。 */
  readonly baseUrl: string;
  /** 启用厂商时的默认模型名。 */
  readonly defaultModel: string;
  /** 是否必需 Key（Ollama 等本地端点免 Key）。 */
  readonly needsKey: boolean;
  /** 兜底已知模型清单（`/models` 不可用时展示）。 */
  readonly models: readonly string[];
  /**
   * 该厂商 `reasoning_effort` 合法值清单（空/缺省 = 该厂商不暴露按强度的推理档位）。
   * 非空时 UI 推理强度下拉按此清单渲染，保证只会挑到端点接受的值。
   */
  readonly reasoningEffort?: readonly string[];
  /** 维护说明（来源、实测日期、为何这么配）——纯文档字段，不参与任何判定。 */
  readonly notes?: string;
}
