/**
 * 大模型厂商预设目录（#模型接入页）。
 * 单一来源：UI 厂商卡片 / Key 探测 / 运行时模型构造共用本表，避免三处漂移。
 * baseUrl 均为 OpenAI 兼容或 Anthropic 原生端点；models 为兜底已知清单（实测 /models 成功时以实测为准）。
 */
export interface ProviderPreset {
  /** 厂商标识（稳定 ID，providerKeys 的键）。 */
  readonly id: string;
  /** 展示名。 */
  readonly label: string;
  /** 底层适配器类型（对应 FileConfig.modelAdapter）。 */
  readonly adapter: 'openai' | 'anthropic' | 'responses';
  /** 默认端点。 */
  readonly baseUrl: string;
  /** 启用厂商时的默认模型名。 */
  readonly defaultModel: string;
  /** 是否必需 Key（Ollama 等本地端点免 Key）。 */
  readonly needsKey: boolean;
  /** 兜底已知模型清单（/models 不可用时展示）。 */
  readonly models: readonly string[];
  /**
   * 该厂商 reasoning_effort 合法值清单（#B6 扩展，2026-09-08）：
   * - undefined / []：表示该厂商不暴露「按强度」的推理档位——UI 退回到内置兜底列表
   *   （向后兼容；后续可逐家实测填充）。
   * - 非空：UI 推理强度下拉按此清单渲染（覆盖兜底），保证用户只会挑端点接受的值。
   * 来源：
   * - deepseek v4 系列经 curl T4（2026-09-07）实测：unknown variant 错误枚举出 7 个合法值。
   * - openai o-series / gpt-5：官方文档公开 5 个档位（o3 不接 minimal/xhigh，列表为厂商并集）。
   * - moonshot kimi k2、zhipu glm-4.5：基于厂商文档的 thinking effort 档位。
   * - dashscope / ollama：当前模型族无 reasoning_effort 概念（dashscope 用 thinking_budget），
     设为 [] 让 UI 显示"无推理档位"。
   * - anthropic claude：使用 thinking.budget_tokens 而非 effort 档位，UI 当前不渲染 budget 滑条，
     设为 [] 待后续按 token 预算重做下拉控件。
   */
  readonly reasoningEffort?: readonly string[];
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    adapter: 'openai',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-v4-flash',
    needsKey: true,
    // deepseek v4 系列（deepseek 在 2026 上线的新版主模型）。
    // 实测 /v1/models 失败时回退到这里，并保证 UI 刷新后下拉至少 3 项可选。
    models: ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-v4-pro'],
    // 2026-09-07 现场实测：T4 触发 unknown variant 错误，DeepSeek 自身枚举出 7 个合法值。
    // "强"档（high）是用户当前默认；把"none"/"max"也暴露，避免高强度需求被挡在下拉外。
    reasoningEffort: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    id: 'moonshot',
    label: 'Moonshot Kimi',
    adapter: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'kimi-k2-turbo-preview',
    needsKey: true,
    models: [
      'kimi-k2-turbo-preview',
      'kimi-k2-0905-preview',
      'moonshot-v1-8k',
      'moonshot-v1-32k',
      'moonshot-v1-128k',
    ],
    // Kimi K2 thinking effort 档位（厂商文档 3 档）。
    reasoningEffort: ['low', 'medium', 'high'],
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    adapter: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4.5-flash',
    needsKey: true,
    models: ['glm-4.5', 'glm-4.5-air', 'glm-4.5-flash', 'glm-4-plus'],
    // GLM-4.5 reasoning 档位（厂商文档 3 档）。
    reasoningEffort: ['low', 'medium', 'high'],
  },
  {
    id: 'dashscope',
    label: '阿里通义 Qwen',
    adapter: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    needsKey: true,
    models: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen3-coder-plus'],
    // dashscope 走 thinking_budget 而非 effort，OpenAI 兼容层不暴露该参数；UI 隐藏下拉。
    reasoningEffort: [],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    adapter: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    needsKey: true,
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'o3'],
    // GPT-5 / o-series 公开 effort 档位（厂商并集；o3 不接 minimal/xhigh，端点会自己 400）。
    reasoningEffort: ['minimal', 'low', 'medium', 'high', 'xhigh'],
  },
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    adapter: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-4-20250514',
    needsKey: true,
    models: ['claude-sonnet-4-20250514', 'claude-opus-4-20250514', 'claude-3-5-haiku-20241022'],
    // Anthropic 用 thinking.budget_tokens，非 effort 档位；后续重做下拉再填。
    reasoningEffort: [],
  },
  {
    id: 'ollama',
    label: 'Ollama（本地）',
    adapter: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'qwen3:8b',
    needsKey: false,
    models: [],
    // Ollama 模型各异，UI 显示「无推理档位」让用户按本地模型自己决定。
    reasoningEffort: [],
  },
];

/** 按厂商标识查预设。 */
export function providerPresetOf(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}

/** Key 打码：保留前 3 后 4，中间星号；短 Key 全打码。凭据永不回传 UI。 */
export function maskKey(key: string): string {
  if (key.length <= 8) return '****';
  return `${key.slice(0, 3)}****${key.slice(-4)}`;
}
