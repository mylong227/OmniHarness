import { builtinDefaults } from '../util/builtinDefaults.js';
import type { ProviderPresetConfig } from './configFile.js';

/** 厂商预设（运行时视图）：与 `defaults/providers.json` 记录、配置段 `providerPresets` 同形。 */
export type ProviderPreset = ProviderPresetConfig;

/** 单条预设允许出现的 key 全集（多余 key 一律拒绝——拼错字段会被静默忽略才最危险）。 */
const PRESET_KEYS: ReadonlySet<string> = new Set([
  'id',
  'label',
  'adapter',
  'cliAdapters',
  'baseUrl',
  'defaultModel',
  'needsKey',
  'models',
  'reasoningEffort',
  'notes',
]);

/** 允许的底层适配器取值。 */
const ADAPTERS: ReadonlySet<string> = new Set(['openai', 'anthropic', 'responses']);

/**
 * 大模型厂商目录（**单一来源**）。
 *
 * ## 为什么有这个类（用户指令：不要在代码里硬编码，方便以后维护）
 *
 * 原先厂商目录硬编码在 `server/services/providerPresets.ts`，而 CLI 又独立维护了一份
 * `ADAPTER_PRESETS` 手工副本（注释自称「与 providerPresets.ts 同源同步」）——加一家厂商
 * 要改两处，且两处一旦漂移就会出现「UI 有这家厂商、CLI 解析不到」的隐性缺口。
 * 现改为：**数据**来自随包发布的 `defaults/providers.json`，**合并/派生逻辑**只有这一份，
 * CLI 与服务端共用同一实例。改厂商 = 改数据。
 *
 * ## 覆盖语义（显式优先于隐式）
 *
 * `omniharness.json` 的 `providerPresets` 按 `id` **整条替换**内建预设、新 `id` **追加**；
 * 不做字段级浅合并——否则「没写的字段继承内建值」会在厂商信息变更时静默漂移，
 * 且用户无法从配置文件本身看出最终生效值。缺字段一律被 {@link normalize} 拒绝（fail-closed）。
 */
export class ProviderPresets {
  /** 内建厂商目录（来自 `defaults/providers.json`，构造期已逐条校验）。 */
  private readonly builtinPresets: readonly ProviderPreset[];

  /**
   * @param rawBuiltin `defaults/providers.json` 的原始内容（`{ presets: [...] }`）。
   *   构造期即逐条校验并归一化；非法条目抛错（不静默丢弃，否则 UI/CLI 会「少一家厂商」而无提示）。
   * @throws Error 结构非法、缺字段、字段类型错误、adapter 越界、id 重复时抛出
   */
  public constructor(rawBuiltin: unknown) {
    this.builtinPresets = this.parseBuiltin(rawBuiltin);
  }

  /**
   * 内建目录（未叠加用户覆盖）。
   * @returns 内建厂商预设清单（只读）
   */
  public get builtin(): readonly ProviderPreset[] {
    return this.builtinPresets;
  }

  /**
   * 求解生效目录：内建目录 + 用户覆盖（同 `id` 整条替换，新 `id` 追加到末尾）。
   * @param overrides 配置文件 `providerPresets` 段（可缺省）
   * @returns 生效的厂商预设清单；无覆盖时返回内建目录本身（零成本、零漂移）
   * @throws Error 任一条目非法时抛出（fail-closed）
   */
  public resolve(overrides?: readonly ProviderPresetConfig[]): readonly ProviderPreset[] {
    if (overrides === undefined || overrides.length === 0) {
      return this.builtinPresets;
    }
    const normalized = (overrides as readonly unknown[]).map((entry, index) =>
      this.normalize(entry, `providerPresets[${index}]`),
    );
    const dup = this.firstDuplicate(normalized);
    if (dup !== undefined) {
      throw new Error(
        `providerPresets 存在重复厂商 id：${dup}（同一 id 只能出现一次，否则生效值取决于顺序）`,
      );
    }
    const replaced = new Map(normalized.map((preset) => [preset.id, preset]));
    const builtinIds = new Set(this.builtinPresets.map((preset) => preset.id));
    const kept = this.builtinPresets.map((preset) => replaced.get(preset.id) ?? preset);
    return [...kept, ...normalized.filter((preset) => !builtinIds.has(preset.id))];
  }

  /**
   * 按厂商标识查预设（含用户覆盖）。
   * @param id 厂商标识
   * @param overrides 配置文件 `providerPresets` 段（可缺省）
   * @returns 命中的预设；无此厂商时 undefined
   * @throws Error 覆盖条目非法时抛出（与 {@link resolve} 同源）
   */
  public byId(id: string, overrides?: readonly ProviderPresetConfig[]): ProviderPreset | undefined {
    return this.resolve(overrides).find((preset) => preset.id === id);
  }

  /**
   * 取某个 CLI `--model-adapter` 取值对应的全部厂商预设。
   *
   * 对应关系由预设自带的 `cliAdapters` 决定（缺省 `[adapter]`）——这把原先只存在于 CLI 副本里的
   * 隐含映射（如 `responses` → openai、`llamacpp` → ollama）变成了**数据**，不再有第二处需要同步。
   * @param adapter CLI `--model-adapter` 取值
   * @param presets 生效目录（缺省内建目录；调用方应传 `resolve(...)` 的结果以纳入用户覆盖）
   * @returns 该适配器下的预设清单（按目录顺序；无匹配返回空数组）
   */
  public forAdapter(
    adapter: string,
    presets: readonly ProviderPreset[] = this.builtinPresets,
  ): readonly ProviderPreset[] {
    return presets.filter((preset) => (preset.cliAdapters ?? [preset.adapter]).includes(adapter));
  }

  /**
   * 解析 `defaults/providers.json`（`{ presets: [...] }`）。
   * @param raw 原始 JSON 值
   * @returns 已校验的内建目录
   * @throws Error 顶层结构非法或存在非法条目时抛出
   */
  private parseBuiltin(raw: unknown): readonly ProviderPreset[] {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error('defaults/providers.json 顶层应为对象：{ presets: [...] }');
    }
    const presets = (raw as Record<string, unknown>)['presets'];
    if (!Array.isArray(presets) || presets.length === 0) {
      throw new Error(
        'defaults/providers.json 的 presets 应为非空数组（空目录会让 UI 无厂商可选）',
      );
    }
    const normalized = presets.map((entry, index) =>
      this.normalize(entry, `defaults/providers.json presets[${index}]`),
    );
    const dup = this.firstDuplicate(normalized);
    if (dup !== undefined) {
      throw new Error(`defaults/providers.json 存在重复厂商 id：${dup}`);
    }
    return normalized;
  }

  /**
   * 逐条校验并归一化一条厂商预设（内建数据与用户覆盖**同一套规则**）。
   * @param entry 原始条目
   * @param where 报错定位前缀（如 `providerPresets[0]`）
   * @returns 归一化后的预设
   * @throws Error 结构、字段类型或取值非法时抛出
   */
  private normalize(entry: unknown, where: string): ProviderPreset {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`${where} 应为对象（厂商预设）`);
    }
    const raw = entry as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      if (!PRESET_KEYS.has(key)) {
        throw new Error(`${where} 含未知 key '${key}'（允许：${[...PRESET_KEYS].join(' / ')}）`);
      }
    }
    // 先定「这是哪一条」（id）再报字段错——否则一条空白覆盖只会说「adapter 未定义」，
    // 维护者看不出是哪家厂商的配置写坏了。
    const id = this.requireToken(raw['id'], `${where}.id`);
    const adapter = raw['adapter'];
    if (typeof adapter !== 'string' || !ADAPTERS.has(adapter)) {
      throw new Error(
        `${where}.adapter 应为 openai / anthropic / responses（当前 ${JSON.stringify(adapter)}）`,
      );
    }
    if (typeof raw['needsKey'] !== 'boolean') {
      throw new Error(`${where}.needsKey 应为布尔值`);
    }
    const preset: ProviderPreset = {
      id,
      label: this.requireText(raw['label'], `${where}.label`),
      adapter: adapter as ProviderPreset['adapter'],
      baseUrl: this.requireUrl(raw['baseUrl'], `${where}.baseUrl`),
      defaultModel: this.requireText(raw['defaultModel'], `${where}.defaultModel`),
      needsKey: raw['needsKey'],
      models: this.requireTokenList(raw['models'], `${where}.models`),
      ...(raw['cliAdapters'] === undefined
        ? {}
        : { cliAdapters: this.requireTokenList(raw['cliAdapters'], `${where}.cliAdapters`) }),
      ...(raw['reasoningEffort'] === undefined
        ? {}
        : {
            reasoningEffort: this.requireTokenList(
              raw['reasoningEffort'],
              `${where}.reasoningEffort`,
            ),
          }),
      ...(raw['notes'] === undefined
        ? {}
        : { notes: this.requireText(raw['notes'], `${where}.notes`) }),
    };
    return preset;
  }

  /**
   * 标识类字符串校验：非空、不含空白（厂商 id / 模型名 / 适配器名含空格必然拼错）。
   * @param value 待校验值
   * @param where 报错定位
   * @returns 原字符串
   * @throws Error 非字符串、空白或含空白时抛出
   */
  private requireToken(value: unknown, where: string): string {
    if (typeof value !== 'string' || value.trim() === '' || /\s/.test(value)) {
      throw new Error(`${where} 应为非空且不含空白的字符串（当前 ${JSON.stringify(value)}）`);
    }
    return value;
  }

  /**
   * 文本类字符串校验：非空即可（展示名本身允许含空格，如 `Moonshot Kimi` / `智谱 GLM`）。
   * @param value 待校验值
   * @param where 报错定位
   * @returns 原字符串
   * @throws Error 非字符串或全空白时抛出
   */
  private requireText(value: unknown, where: string): string {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`${where} 应为非空字符串（当前 ${JSON.stringify(value)}）`);
    }
    return value;
  }

  /**
   * 端点校验：非空字符串且为 http(s)。
   * @param value 待校验值
   * @param where 报错定位
   * @returns 原端点字符串
   * @throws Error 非字符串或不以 http:// / https:// 开头时抛出
   */
  private requireUrl(value: unknown, where: string): string {
    if (typeof value !== 'string' || !/^https?:\/\/\S+$/.test(value)) {
      throw new Error(`${where} 应为 http(s) 端点（当前 ${JSON.stringify(value)}）`);
    }
    return value;
  }

  /**
   * 标识数组校验（元素逐个走 {@link requireToken}）。
   * @param value 待校验值
   * @param where 报错定位
   * @returns 原数组（只读视图）
   * @throws Error 非数组或含非法元素时抛出
   */
  private requireTokenList(value: unknown, where: string): readonly string[] {
    if (!Array.isArray(value)) {
      throw new Error(`${where} 应为字符串数组（当前 ${JSON.stringify(value)}）`);
    }
    return value.map((item, index) => this.requireToken(item, `${where}[${index}]`));
  }

  /**
   * 找第一个重复的厂商 id。
   * @param presets 已归一化清单
   * @returns 首个重复 id；无重复返回 undefined
   */
  private firstDuplicate(presets: readonly ProviderPreset[]): string | undefined {
    const seen = new Set<string>();
    for (const preset of presets) {
      if (seen.has(preset.id)) {
        return preset.id;
      }
      seen.add(preset.id);
    }
    return undefined;
  }
}

/**
 * 默认目录实例（组合根单例）：内建数据在构造期读出并校验，缺文件/数据非法即当场抛错。
 */
export const providerPresets = new ProviderPresets(builtinDefaults.json('providers'));

/** 内建厂商目录（未叠加 `omniharness.json` 覆盖）。 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = providerPresets.builtin;
