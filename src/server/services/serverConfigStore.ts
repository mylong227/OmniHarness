import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { configFile, type FileConfig } from '../../config/configFile.js';
import { ConfigError } from '../../config/configError.js';
import { PERSISTABLE_KEYS } from '../core/appServerState.js';
import { ProviderPresets, type ProviderPreset } from './providerPresets.js';
import { PortablePath } from '../../util/portablePath.js';

/** 配置存储依赖。 */
export interface ServerConfigStoreDeps {
  /** 启动时传入的可读配置摘要（字符串标识）。 */
  readonly displayConfig: Record<string, string>;
  /** 持久化目标路径（undefined 时按工作区推断并创建项目 omniharness.json）。 */
  readonly configPath?: string | undefined;
  /** 启动标志 --auto-approve。 */
  readonly autoApprove: boolean;
  /** 启用厂商时的实测回调（写探测缓存）；探测失败不阻断启用。 */
  readonly probeProvider: (preset: ProviderPreset, key: string | undefined) => Promise<void>;
  /** 配置变更后回调（用于重建 Agent）。 */
  readonly onChanged: () => void;
  /**
   * 用户级配置的家目录覆盖（缺省 `os.homedir()`）。
   *
   * 存在理由：`fileConfig()` 现在走**分层加载**（见该方法注释），单测必须能在临时目录里造出
   * 「用户级 providerKeys + 项目级 model」两层，否则断言会渗进真实机器上的 `~/.omniharness/`。
   */
  readonly userHomedir?: string | undefined;
}

/**
 * 服务端配置存储：持有 UI 覆盖态（fieldOverrides）、持久化路径与 autoApprove 开关，
 * 对外提供「可读摘要（凭据打码）/ 生效文件配置 / 更新落盘 / 工作区列表与新增」。
 *
 * 所有落盘走 `configFile.save` 的归一化校验（fail-closed：非法枚举/类型直接抛错）。
 * 探测副作用（启用厂商）经注入的 `probeProvider` 回调完成——本类不直接依赖探测实现，
 * 保持「配置」与「模型」两个域的边界。
 */
export class ServerConfigStore {
  /**
   * **本机运行态**键：只落用户级配置，绝不写进项目文件（私密/易变，见 {@link persistLocalState}）。
   */
  private static readonly LOCAL_STATE_KEYS: readonly string[] = ['workspace', 'workspaces'];

  /** 存储依赖（摘要 / 初始路径 / autoApprove / 探测与变更回调）。 */
  private readonly deps: ServerConfigStoreDeps;
  /** UI 经 config.update 写入的字段覆盖（落盘 + 实时合并进 fileConfig）。 */
  private overrides: Partial<FileConfig> = {};

  /** 本次 `update` 里被显式清除的键（`persist` 落盘时据此删除，用完即清）。 */
  private clearedKeys: readonly string[] = [];
  /** 持久化目标路径（首次 persist 后固化）。 */
  private path: string | undefined;
  /** autoApprove 开关运行态（update 可切换）。 */
  private auto: boolean;

  /**
   * @param deps 摘要、初始路径、autoApprove、探测回调与变更回调
   */
  public constructor(deps: ServerConfigStoreDeps) {
    this.deps = deps;
    this.path = deps.configPath;
    this.auto = deps.autoApprove;
  }

  /** 当前 autoApprove 开关（UI「工具全部自动放行」）。 */
  public get autoApprove(): boolean {
    return this.auto;
  }

  /**
   * UI 覆盖的 modelAdapter（无覆盖时 undefined）。
   * @returns 覆盖的适配器名；无覆盖返回 undefined。
   */
  public adapterOverride(): string | undefined {
    return this.overrides.modelAdapter;
  }

  /**
   * UI 覆盖的审批档位（无覆盖时 undefined）。
   * @returns 覆盖的审批档位名；无覆盖返回 undefined。
   */
  public approvalOverride(): string | undefined {
    return this.overrides.approval;
  }

  /**
   * 可读配置摘要（供 UI 设置面板；实时合并已落盘文件值与 UI 覆盖）。
   * apiKey/providerKeys 一律打码——凭据原文永不回传 UI。
   * @returns 合并后的配置对象（含 `autoApprove`）
   */
  public get(): unknown {
    const merged: Record<string, unknown> = {
      ...this.deps.displayConfig,
      ...this.fileConfig(),
      ...this.overrides,
      autoApprove: this.auto,
    };
    // 工作区必须报**实际运行根**（2026-10-06 第六十二轮真机 UI 跑测实测）：项目配置文件里落盘的
    // `workspace` 是 UI「上次选中工作区」的运行时状态，它会在上面的合并里**盖掉** displayConfig 的
    // 真实根 ⇒ 界面显示的"当前工作区"与实际跑的不是同一个（本机实测：serve 起在仓库，
    // config.get 却回 `D:\work\新项目`）。运行根本身早已被 runServe 钉死（那是第六十轮的修复），
    // 这里补的是**显示侧**——"显示 ≠ 实际"是本仓反复踩过的一类缺陷（2026-09-27 的
    // modelAdapter / reasoning 各一次）。UI 显式切换工作区仍以 overrides 优先（见 `workspace()`）。
    merged['workspace'] = this.workspace();
    if (typeof merged['apiKey'] === 'string' && merged['apiKey'] !== '') {
      merged['apiKey'] = ProviderPresets.maskKey(merged['apiKey']);
    }
    const pk = merged['providerKeys'];
    if (pk !== undefined && typeof pk === 'object' && !Array.isArray(pk)) {
      const masked: Record<string, string> = {};
      for (const [vendor, key] of Object.entries(pk as Record<string, unknown>)) {
        if (typeof key === 'string') masked[vendor] = ProviderPresets.maskKey(key);
      }
      merged['providerKeys'] = masked;
    }
    return merged;
  }

  /**
   * 生效的文件级配置：**分层加载**（用户级 → 项目级 → profile → bundle → 环境变量）+ UI 覆盖。
   *
   * **为什么要分层（2026-10-06 第六十二轮真机 UI 跑测实测的缺陷）**：本方法原先只读**项目级那一份**
   * （`configFile.load(configPath)`），于是用户级 `~/.omniharness/omniharness.json` 里的
   * `providerKeys` 在 RPC 面**完全不可见** ⇒ `model.probe` 与 `ModelCatalogService.resolveOverride()`
   * 在「用户级配 Key、项目级配 model」这种**最常见**的配置下抛
   * 「厂商 DeepSeek 未配置 API Key，无法启用（fail-closed）」，Web UI 一发真模型回合就在流里报错；
   * 而 `dsh exec`（`execCli.loadDefaults`）与 serve 启动路径（`loadServeConfig`）都走分层、一切正常
   * —— 于是表现为「命令行能用、Web UI 不能用」。
   *
   * 这与 2026-09-27 修过的是**同一类**「用户级被静默忽略」，只是换了条通路（那次修的是启动路径，
   * 这次是 RPC 面）。回归判据见 `tests/unit/serverConfigStoreLayering.test.ts`。
   *
   * @returns 合并后的文件级配置。
   */
  public fileConfig(): FileConfig {
    const layered = configFile.loadLayered({
      workspace: this.workspace(),
      configPath: this.configFilePath(),
      ...(this.deps.userHomedir !== undefined ? { userHomedir: this.deps.userHomedir } : {}),
    });
    return ConfigError.mergeConfigs(layered, this.overrides);
  }

  /**
   * **持久化层**的配置：只读项目级那一份（`persist()` / 写路径的合并基准）。
   *
   * 为什么读与写必须分开：`fileConfig()` 现在含用户级内容，若拿它当**写基准**，用户级凭据会在
   * 任何一次 `config.update` 时被**复制进项目文件**（用户把 Key 放用户级，正是为了不落到项目里）。
   * 故写路径一律以本方法为基准：只合并「项目文件 + UI 覆盖」。
   * @returns 项目级配置（文件不存在为空配置）。
   */
  private persistedConfig(): FileConfig {
    return configFile.load(this.configFilePath());
  }

  /**
   * 当前生效工作区根目录（UI 覆盖优先，回退启动参数 → cwd）。
   * @returns 工作区根目录路径。
   */
  public workspace(): string {
    return this.overrides.workspace ?? this.deps.displayConfig['workspace'] ?? process.cwd();
  }

  /**
   * 工作区列表（UI「添加项目」维护）：已落盘列表 ∪ 当前生效工作区，去重保序。
   * @returns `{ current: string; workspaces: string[] }`
   */
  public workspaces(): { current: string; workspaces: string[] } {
    const saved = this.fileConfig().workspaces ?? [];
    const current = this.workspace();
    return { current, workspaces: [...new Set([current, ...saved])] };
  }

  /**
   * 更新服务端配置：autoApprove 切换 + 持久化 FileConfig 字段到 omniharness.json。
   * 特殊动作参数（不落盘，消费后即弃）：
   *   setProviderKey: { vendor, key } —— 单厂商 Key 原子合并/清除（UI 只持有打码值，不能整表替换）。
   *   enableProvider: string（配合 model 选模型）—— 一键启用厂商：写 modelAdapter/baseUrl/model/apiKey。
   * @param params RPC 参数
   * @returns `{ ok: true; saved: string|undefined; autoApprove: boolean }`
   */
  public async update(params: Record<string, unknown>): Promise<unknown> {
    const aa = params['autoApprove'];
    if (aa === true || aa === false) {
      this.auto = aa;
    }
    const patch: Record<string, unknown> = {};
    const cleared: string[] = [];
    for (const key of PERSISTABLE_KEYS) {
      const value = params[key];
      if (value === null) {
        // `null` = **显式清除覆盖**（回落厂商默认/文件配置）。
        // 为什么必须有这条：此前 undefined 是 no-op、空串会被原样写盘并把 `baseUrl` 覆写成 ''
        // （破坏厂商端点拼装）、null 会被持久化成 null（同样炸）⇒ UI 上「清空」根本做不到。
        cleared.push(key);
        continue;
      }
      if (value !== undefined) {
        patch[key] = value;
      }
    }
    this.applyProviderKeyPatch(params, patch);
    await this.applyEnableProvider(params, patch);
    if (Object.keys(patch).length > 0 || cleared.length > 0) {
      // 先构造候选、落盘成功后才提交内存（2026-09-26 审计 S22）：`persist()` 会经
      // `normalizeConfig` 校验并可能抛错，旧实现**先改内存再落盘** ⇒ 抛错时 UI/内存已显示新配置，
      // 而磁盘与在跑的 Agent 仍是旧配置（且 clearedKeys 残留到下次写入），形成静默不一致。
      const previousOverrides = this.overrides;
      const previousCleared = this.clearedKeys;
      const next = ConfigError.mergeConfigs(this.overrides, patch as Partial<FileConfig>);
      for (const key of cleared) {
        delete (next as Record<string, unknown>)[key];
      }
      this.overrides = next;
      this.clearedKeys = cleared;
      try {
        this.persist();
      } catch (error) {
        this.overrides = previousOverrides;
        this.clearedKeys = previousCleared;
        throw error;
      }
      this.clearedKeys = [];
    }
    this.deps.onChanged();
    return { ok: true, saved: this.path, autoApprove: this.auto };
  }

  /**
   * 校验候选路径为存在目录并返回绝对路径；fail-closed：不存在/非目录直接抛错回 RPC。
   * @param raw 候选路径（未知类型）
   * @returns 绝对路径
   */
  public requireDirectory(raw: unknown): string {
    const candidate = typeof raw === 'string' ? raw.trim() : '';
    if (candidate === '') {
      throw new Error('路径不能为空');
    }
    const root = resolve(candidate);
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      throw new Error('目录不存在或不是文件夹: ' + root);
    }
    return root;
  }

  /**
   * 「添加项目」：校验目录后并入 workspaces 列表并持久化。
   * @param raw 候选路径
   * @returns 最新工作区列表
   */
  public addWorkspace(raw: unknown): unknown {
    const root = this.requireDirectory(raw);
    const list = this.localState().workspaces ?? this.persistedConfig().workspaces ?? [];
    if (!list.includes(root)) {
      this.overrides = { ...this.overrides, workspaces: [...list, root] };
      this.persist();
    }
    return this.workspaces();
  }

  /**
   * 提交工作区切换：把新根写入覆盖并持久化，旧当前工作区一并收编进列表
   * （它此前可能只是启动参数、从未入列表），防止切走后从面板消失。
   * @param root 新工作区根
   * @param previous 切换前的工作区根
   * @returns 最新工作区列表
   */
  public commitWorkspaceSwitch(
    root: string,
    previous: string,
  ): { current: string; workspaces: string[] } {
    // 写基取**本机运行态**那份（用户级）：项目文件不再承载项目列表，若拿它当基会把列表写回项目文件。
    const saved = this.localState().workspaces ?? this.persistedConfig().workspaces ?? [];
    this.overrides = {
      ...this.overrides,
      workspace: root,
      workspaces: [...new Set([previous, ...saved, root])],
    };
    this.persist();
    return this.workspaces();
  }

  /**
   * 把覆盖配置合并进项目配置文件并写盘（目录不存在自动创建）。
   * @returns 无返回值。
   */
  public persist(): void {
    const path = this.configFilePath();
    const existing = configFile.load(path);
    // 项目文件**只收项目级设置**：本机运行态（当前项目 / 项目列表）走 persistLocalState（见其注释）。
    const projectOverrides = Object.fromEntries(
      Object.entries(this.overrides).filter(
        ([key]) => !ServerConfigStore.LOCAL_STATE_KEYS.includes(key),
      ),
    );
    const merged = ConfigError.mergeConfigs(existing, projectOverrides) as Record<string, unknown>;
    // 被显式清除的键必须从**落盘结果**里删掉：`mergeConfigs` 只做覆盖不做删除，
    // 否则「清除 base-url」会被旧文件里的值悄悄复活（UI 显示清了、实际没清）。
    for (const key of this.clearedKeys) {
      delete merged[key];
    }
    // 自愈：旧版本把「当前项目 / 项目列表」写进过项目文件（本机运行态被当成项目设置）。既然它不属于
    // 项目，落盘时一律剔除——既避免随项目上传，也避免换机后指向幽灵路径。
    for (const key of ServerConfigStore.LOCAL_STATE_KEYS) {
      delete merged[key];
    }
    configFile.save(path, merged as Partial<FileConfig>);
    this.path = path;
    this.persistLocalState();
  }

  /**
   * 把「当前项目 / 项目列表」写进**用户级**配置（`~/.omniharness/omniharness.json`）。
   *
   * **为什么必须与项目文件分开写**（2026-10-06 用户口径）：`workspace` 是"我上次在用哪个项目"的
   * **本机运行态**，不是项目自身的设置。它一旦写进项目里的 `omniharness.json`：
   * ① 会随项目**上传/提交**出去（用户在别的机器上 clone 后会被带到别人的项目路径上）；
   * ② 换台机器/换个启动目录就指向不存在的路径。
   * 用户的要求是「私密配置落本地、不随项目上传；无论从哪启动都读得到项目」——故本机运行态一律落
   * 用户级文件，项目文件里**不再出现** `workspace` / `workspaces`。
   * @returns 无返回值。
   */
  private persistLocalState(): void {
    const keys = ServerConfigStore.LOCAL_STATE_KEYS;
    const home = this.deps.userHomedir ?? homedir();
    const patch: Record<string, unknown> = {};
    for (const key of keys) {
      const value = (this.overrides as Record<string, unknown>)[key];
      if (value === undefined) continue;
      // 写回**可移植形态**：家目录下的路径压成 `~/…`（用户口径："无论何时何地何种机器都能正确读取
      // 为一套配置"）。家目录之外的保持绝对路径——绝不臆造一个在别处不成立的路径。
      patch[key] = Array.isArray(value)
        ? value.map((entry) =>
            typeof entry === 'string' ? PortablePath.compact(entry, home) : entry,
          )
        : typeof value === 'string'
          ? PortablePath.compact(value, home)
          : value;
    }
    if (Object.keys(patch).length === 0 && !keys.some((k) => this.clearedKeys.includes(k))) {
      return;
    }
    const path = this.localStatePath();
    const existing = configFile.load(path);
    const merged = { ...existing, ...patch } as Record<string, unknown>;
    // `null` = 显式清除（与项目文件的 clearedKeys 同口径：merge 只覆盖不删除）。
    for (const key of this.clearedKeys) {
      if (keys.includes(key)) delete merged[key];
    }
    configFile.save(path, merged as Partial<FileConfig>);
  }

  /**
   * 用户级配置路径（本机运行态的家）。
   * @returns 用户级 `omniharness.json` 的绝对路径。
   */
  private localStatePath(): string {
    return join(this.deps.userHomedir ?? homedir(), '.omniharness', configFile.FILE_NAME);
  }

  /**
   * 用户级配置内容（本机运行态：当前项目 / 项目列表）。
   * @returns 用户级配置（文件不存在时为空配置）。
   */
  private localState(): FileConfig {
    return configFile.load(this.localStatePath());
  }

  /**
   * 持久化目标路径：显式 configPath 优先，否则按 displayConfig.workspace 推断。
   * @returns 配置文件绝对路径。
   */
  private configFilePath(): string {
    return (
      this.path ?? join(this.deps.displayConfig['workspace'] ?? process.cwd(), configFile.FILE_NAME)
    );
  }

  /**
   * 合并 setProviderKey 动作进 patch（单厂商 Key 原子合并/清除）。
   * @param params RPC 原始参数（读取 setProviderKey）。
   * @param patch 待应用的覆盖补丁（原地写入 providerKeys）。
   * @returns 无返回值（非法厂商 / 参数时静默跳过）。
   */
  private applyProviderKeyPatch(
    params: Record<string, unknown>,
    patch: Record<string, unknown>,
  ): void {
    const setKey = params['setProviderKey'];
    if (setKey === undefined || typeof setKey !== 'object' || setKey === null) return;
    const vendor = (setKey as Record<string, unknown>)['vendor'];
    const key = (setKey as Record<string, unknown>)['key'];
    if (
      typeof vendor !== 'string' ||
      ProviderPresets.providerPresetOf(vendor, this.fileConfig().providerPresets) === undefined
    )
      return;
    const merged = { ...this.persistedConfig().providerKeys };
    if (typeof key === 'string' && key.length > 0) {
      merged[vendor] = key;
    } else {
      delete merged[vendor]; // 空 Key = 清除该厂商凭据
    }
    patch.providerKeys = merged;
  }

  /**
   * 处理「一键启用厂商」：写适配器/端点/模型/Key，并触发一次实测缓存。
   * @param params RPC 原始参数（读取 enableProvider 与可选 model）。
   * @param patch 待应用的覆盖补丁（原地写入厂商相关字段）。
   * @returns 处理完成后 resolve，无载荷（未知厂商静默跳过，缺 Key 抛错）。
   */
  private async applyEnableProvider(
    params: Record<string, unknown>,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const enable = params['enableProvider'];
    if (typeof enable !== 'string') return;
    const preset = ProviderPresets.providerPresetOf(enable, this.fileConfig().providerPresets);
    if (preset === undefined) return;
    const keys = this.fileConfig().providerKeys ?? {};
    const key = keys[enable];
    if (preset.needsKey && key === undefined) {
      throw new Error(`厂商 ${preset.label} 尚未保存 API Key，请先填写并保存`);
    }
    patch.modelAdapter = preset.adapter;
    patch.baseUrl = preset.baseUrl;
    const chosen = params['model'];
    patch.model = typeof chosen === 'string' && chosen.length > 0 ? chosen : preset.defaultModel;
    if (key !== undefined) {
      patch.apiKey = key; // 运行时构造优先取顶层 apiKey，启用即同步
    }
    await this.deps.probeProvider(preset, key);
  }
}
