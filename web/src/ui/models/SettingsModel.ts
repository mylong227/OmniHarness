// 设置模型：设置面板的**唯一状态与读写通道**（零 React，可在 node 下单测）。
//
// 为什么抽出来（2026-10-17 设置面板重构）：
//   旧 SettingsTab 把三件事混在一个组件里——取数、落盘、渲染。结果是**只有渲染能被测**，
//   而真正容易坏的是「改动 → 落盘 → 重拉回填 → 命中模型相关键时刷新厂商目录」这条闭环。
//   抽成模型后，这条闭环在 node 里可直测（判据见 web/test/configWiring.test.mjs），
//   组件退化成薄视图。
//
// 同时它承载「设置面清单」：哪些键可改、取值域是什么、归在哪一栏。单一事实源，
// 避免"文档写一套、面板写一套、测试再写一套"（本仓历史上漂移过一次，见 §2 的教训）。
//
// 三层语义严格区分（这是本文件最容易写错的地方）：
//   ① 键（key）：`Config` 的字段名——`sandbox` / `autoApprove` / `baseUrl` …
//   ② 字段（Field）：设置面板里的**一行**，带类型与取值域，负责"怎么编辑"
//   ③ 分栏（TAB）：字段归到哪一屏，负责"去哪找"
//   一个键只出现在一个字段里；一个字段只属于一个分栏。断言钉在 web/test/settingsPane.test.mjs。

import type { Config } from '../../types/models.js';
import { t } from '../i18n/i18n.js';

/** 设置分栏 key。 */
export type SettingsTabKey = 'model' | 'runtime' | 'permission' | 'appearance' | 'profiles';

/** 一个分栏。 */
export interface SettingsTabDef {
  /** 分栏 key（路由 `#settings=<key>` 与 `openSettings(tab)` 同值）。 */
  key: SettingsTabKey;
  /** 分栏标题。 */
  label: string;
  /** 一句话说明这一栏管什么（空态/引导用，避免用户靠猜）。 */
  hint: string;
}

/** 分栏清单：顺序即面板内导航顺序（模型 → 运行时 → 权限 → 外观 → 配置集）。 */
export const SETTINGS_TABS: readonly SettingsTabDef[] = [
  { key: 'model', label: '模型', hint: '厂商接入、API Key、默认模型与自定义端点' },
  { key: 'runtime', label: '运行时', hint: '适配器、工作区与沙箱执行环境' },
  { key: 'permission', label: '权限', hint: '审批模式、升级策略与免确认开关' },
  { key: 'appearance', label: '外观', hint: '主题与界面密度' },
  { key: 'profiles', label: '配置集', hint: '切换配置集、查看当前生效插件' },
];

/** 字段类型。 */
export type SettingsFieldKind = 'select' | 'text' | 'switch';

/** 一个设置字段（行）。 */
export interface SettingsField {
  /** `Config` 的字段名。 */
  key: keyof Config;
  /** 所属分栏。 */
  tab: SettingsTabKey;
  /** 行标签。 */
  label: string;
  /** 控件类型。 */
  kind: SettingsFieldKind;
  /** 下拉取值域（kind==='select'）。 */
  options?: readonly string[];
  /** 占位提示（kind==='text'）。 */
  placeholder?: string;
  /** 一行说明。 */
  hint?: string;
  /**
   * 落盘时把值写成"清除"（服务端约定 `null` = 显式清除）而不是 no-op。
   * 目前只有 `baseUrl` 需要：留空＝回落厂商默认端点。
   */
  clearWhenEmpty?: boolean;
  /**
   * [只在服务端配置里出现、但本面板不编辑] 的键（如 providerKeys 由厂商卡片管）不在此声明。
   * 需要额外输入的字段（如 API Key）用 `custom` 承载，见 MODEL_KEY_FIELDS。
   */
}

/**
 * 设置表单全部字段（**单一事实源**）。
 *
 * 顺序 = 分栏内渲染顺序。新增设置项时只改这里 + `SettingsModel` 的读写分支；
 * 不要在组件里另写一份 `<label>` 清单（那正是旧实现漂移的成因）。
 */
export const SETTINGS_FIELDS: readonly SettingsField[] = [
  {
    key: 'model',
    tab: 'model',
    label: '默认模型',
    kind: 'text',
    placeholder: '如 gpt-4o / deepseek-v4-flash',
    hint: '留空则用厂商默认模型',
  },
  {
    key: 'baseUrl',
    tab: 'model',
    label: '自定义 Base URL',
    kind: 'text',
    placeholder: 'OpenAI 兼容端点（留空＝清除覆盖）',
    hint: '留空即回落厂商默认端点',
    clearWhenEmpty: true,
  },
  {
    key: 'modelAdapter',
    tab: 'runtime',
    label: '模型适配器',
    kind: 'select',
    options: ['mock', 'openai', 'anthropic', 'responses'],
    hint: '切换适配器会同时刷新可用模型清单',
  },
  {
    key: 'sandbox',
    tab: 'runtime',
    label: '沙箱',
    kind: 'select',
    options: ['passthrough', 'policy', 'restricted', 'landlock', 'seatbelt', 'bwrap'],
    hint: '命令执行环境的隔离方式',
  },
  {
    key: 'approval',
    tab: 'permission',
    label: '审批模式',
    kind: 'select',
    options: ['auto', 'rules', 'ask'],
    hint: 'auto 全自动 / rules 按规则 / ask 每次询问',
  },
  {
    key: 'escalation',
    tab: 'permission',
    label: '升级审批',
    kind: 'select',
    options: ['deny', 'ask', 'auto'],
    hint: '越权请求（提权/写盘等）的处理方式',
  },
  {
    key: 'autoApprove',
    tab: 'permission',
    label: '自动审批（免人工确认）',
    kind: 'switch',
    hint: '开启后不再弹出审批确认；危险操作仍受沙箱与规则约束',
  },
];

/** 主题取值。 */
export type ThemeMode = 'dark' | 'light';

/**
 * 改动后需要刷新厂商目录（`model.catalog`）的键：
 * 模型下拉与厂商标题随之刷新，否则 UI 与生效配置会漂移一屏。
 */
export const CATALOG_KEYS: readonly string[] = ['model', 'modelAdapter'];

/** 已保存提示的自动消隐时长（ms）。 */
export const SAVED_HINT_MS = 1500;

/** 设置面板渲染所需的快照。 */
export interface SettingsSnapshot {
  /** 服务端配置（未加载时为 null）。 */
  cfg: Config | null;
  /** 自定义 base-url 的受控草稿（留空＝清除覆盖）。 */
  baseUrl: string;
  /** 配置集清单。 */
  profiles: readonly { id: string; name: string }[];
  /** 当前生效插件（已 join）。 */
  activePlugins: string;
  /** 「已保存」提示文案（空串＝不显示）。 */
  savedHint: string;
  /** 是否正在保存（用于按钮 disabled 与提示）。 */
  saving: boolean;
  /** 最近一次错误文案（空串＝无）。 */
  error: string;
}

/** 设置模型依赖的服务端能力。 */
export interface SettingsModelDeps {
  /** 读运行时配置。 */
  getConfig: () => Promise<Config>;
  /** 写运行时配置（补丁语义见 SettingsModel.save）。 */
  updateConfig: (patch: Record<string, unknown>) => Promise<unknown>;
  /** 配置集清单。 */
  listProfiles: () => Promise<readonly { id: string; name: string }[]>;
  /** 当前生效的配置集/插件。 */
  getActiveProfile: () => Promise<{ plugins?: readonly string[] }>;
  /** 应用配置集。 */
  applyProfile: (id: string) => Promise<unknown>;
  /** 厂商目录刷新（命中 CATALOG_KEYS 时调用）。 */
  refreshModelCatalog?: (() => void) | undefined;
  /** 提示（错误与成功各一档）。 */
  toast: (msg: string, kind: 'ok' | 'err') => void;
}

/**
 * 设置模型：取数 / 落盘 / 回填 / 提示，全部收敛在这里。
 *
 * 生命周期：`load()` 一次 → 用户改动触发 `save()` → 内部 `reload()` 回填 → `subscribe` 通知视图。
 * 不做 React 依赖，视图侧用 `useSyncExternalStore` 订阅（见 SettingsModal）。
 */
export class SettingsModel {
  /** 依赖（服务端客户端、通知回调等）。构造后不变。 */
  private readonly deps: SettingsModelDeps;

  /**
   * 当前快照（`useSyncExternalStore` 的取值源）。
   *
   * **引用必须稳定**：每次 `set()` 生成新对象、未变化时沿用旧引用——`useSyncExternalStore`
   * 用 `Object.is` 比较，若每次都造新对象会触发无限重渲染（`EMPTY_SNAPSHOT` 常量即为此保留）。
   */
  private snapshot: SettingsSnapshot = {
    cfg: null,
    baseUrl: '',
    profiles: [],
    activePlugins: '',
    savedHint: '',
    saving: false,
    error: '',
  };

  /** 订阅者集合（视图侧 useSyncExternalStore）。 */
  private readonly listeners = new Set<() => void>();

  /** 「已保存」提示的消隐定时器。 */
  private hintTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param deps 服务端能力与提示通道
   */
  public constructor(deps: SettingsModelDeps) {
    this.deps = deps;
  }

  /**
   * 当前快照（引用稳定：只有变更时才换新对象，`useSyncExternalStore` 依赖这一点）。
   * @returns 快照
   */
  public getSnapshot(): SettingsSnapshot {
    return this.snapshot;
  }

  /**
   * 订阅变更。
   * @param fn 变更回调
   * @returns 取消订阅
   */
  public subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /**
   * 释放：清掉提示定时器，避免测试进程被挂住（旧实现的手工 clearTimeout 已内聚到这里）。
   * @returns 无
   */
  public dispose(): void {
    if (this.hintTimer !== null) {
      clearTimeout(this.hintTimer);
      this.hintTimer = null;
    }
    this.listeners.clear();
  }

  /**
   * 首次装载：拉配置 + 配置集清单（两者独立容错，任一失败不阻断另一条）。
   * @returns 异步完成
   */
  public async load(): Promise<void> {
    await Promise.all([this.reload(), this.reloadProfiles()]);
  }

  /**
   * 重新拉取运行时配置并回填；失败静默（保留当前值，不打断用户正在输入的内容）。
   * @returns 异步完成
   */
  public async reload(): Promise<void> {
    try {
      this.applyConfig(await this.deps.getConfig());
    } catch {
      /* 静默：配置不可用时保留当前表单值 */
    }
  }

  /**
   * 拉取配置集清单与当前生效插件；失败静默（profile 服务不可用不该阻断设置渲染）。
   * @returns 异步完成
   */
  public async reloadProfiles(): Promise<void> {
    try {
      const list = await this.deps.listProfiles();
      const active = await this.deps.getActiveProfile();
      this.set({
        profiles: list.map((p) => ({ id: p.id, name: p.name })),
        activePlugins: (active.plugins ?? []).join(t('、')),
      });
    } catch {
      /* 静默：profile 服务不可用时保留上一帧 */
    }
  }

  /**
   * 用服务端配置回填快照（首拉与保存后重拉共用，避免两处取值漂移）。
   * @param c 服务端配置
   * @returns 无
   */
  public applyConfig(c: Config): void {
    this.set({ cfg: c, baseUrl: (c.baseUrl as string) ?? '' });
  }

  /**
   * 落盘一个补丁，成功后重拉配置并闪现「已保存」；命中 CATALOG_KEYS 时刷新厂商目录。
   *
   * 失败语义（判据见 configWiring.test.mjs 第 4 条）：**只提示错误，不重拉配置**——
   * 失败后重拉会把表单回填成服务端旧值，用户会以为"改动生效了但又变回去了"（假刷新）。
   * @param patch 配置补丁
   * @returns 异步完成
   */
  public async save(patch: Record<string, unknown>): Promise<void> {
    this.set({ saving: true, error: '' });
    try {
      await this.deps.updateConfig(patch);
      this.flashSaved(t('已保存'));
      await this.reload();
      if (Object.keys(patch).some((k) => CATALOG_KEYS.includes(k))) this.deps.refreshModelCatalog?.();
    } catch (e) {
      const msg = t('保存失败：{msg}', { msg: (e as Error).message });
      this.set({ error: msg });
      this.deps.toast(msg, 'err');
    } finally {
      this.set({ saving: false });
    }
  }

  /**
   * 按字段落盘：把"界面里的值"翻成"配置补丁"。
   *
   * 两处语义要注意：
   *   · `clearWhenEmpty` 的字段（baseUrl）留空 ⇒ 发 `null`（**显式清除**）而不是 `undefined`
   *     （后者是 no-op，空串会被当成真实端点写坏 URL 拼装）；
   *   · 文本字段一律 trim；`model` 清空时发 `undefined`（回落厂商默认）。
   * @param field 字段定义
   * @param raw 控件给出的原始值（字符串或布尔）
   * @returns 异步完成
   */
  public async saveField(field: SettingsField, raw: string | boolean): Promise<void> {
    if (field.kind === 'switch') {
      await this.save({ [field.key]: raw === true });
      return;
    }
    const v = String(raw).trim();
    if (field.key === 'baseUrl') {
      this.set({ baseUrl: v });
      await this.save(v ? { baseUrl: v } : { baseUrl: null });
      return;
    }
    if (field.key === 'model') {
      await this.save(v ? { model: v } : { model: undefined });
      return;
    }
    await this.save({ [field.key]: v });
  }

  /**
   * 应用配置集（即时生效），成功后刷新生效插件回显。
   * @param id 配置集 id（空串忽略）
   * @returns 异步完成
   */
  public async applyProfile(id: string): Promise<void> {
    if (id === '') return;
    try {
      await this.deps.applyProfile(id);
      this.deps.toast(t('已应用配置集'), 'ok');
      await this.reloadProfiles();
    } catch (e) {
      this.deps.toast(t('应用配置集失败：{msg}', { msg: (e as Error).message }), 'err');
    }
  }

  /**
   * 取某字段在当前配置里的值（视图回填用；未加载时给空串）。
   * @param key 配置键
   * @returns 显示值
   */
  public valueOf(key: keyof Config): string {
    const c = this.snapshot.cfg;
    if (c === null) return '';
    if (key === 'baseUrl') return this.snapshot.baseUrl;
    const v = c[key];
    return v === undefined || v === null ? '' : String(v);
  }

  /**
   * 取某字段的布尔值（switch 用）。
   * @param key 配置键
   * @returns 是否开启
   */
  public boolOf(key: keyof Config): boolean {
    return this.snapshot.cfg?.[key] === true;
  }

  /**
   * 闪现「已保存」并在 SAVED_HINT_MS 后自动消隐（重入时重置计时）。
   * @param text 提示文案
   * @returns 无
   */
  private flashSaved(text: string): void {
    this.set({ savedHint: text });
    if (this.hintTimer !== null) clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => {
      this.hintTimer = null;
      this.set({ savedHint: '' });
    }, SAVED_HINT_MS);
  }

  /**
   * 合并快照并通知订阅者（引用变化才通知，避免无谓重渲染）。
   * @param patch 快照补丁
   * @returns 无
   */
  private set(patch: Partial<SettingsSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const fn of this.listeners) fn();
  }
}
