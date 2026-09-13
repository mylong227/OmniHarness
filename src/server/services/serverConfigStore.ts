import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { configFile, type FileConfig } from '../../config/configFile.js';
import { mergeConfigs } from '../../config/configError.js';
import { PERSISTABLE_KEYS } from '../core/appServerState.js';
import { providerPresetOf, maskKey, type ProviderPreset } from './providerPresets.js';

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
  /** 存储依赖（摘要 / 初始路径 / autoApprove / 探测与变更回调）。 */
  private readonly deps: ServerConfigStoreDeps;
  /** UI 经 config.update 写入的字段覆盖（落盘 + 实时合并进 fileConfig）。 */
  private overrides: Partial<FileConfig> = {};
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
    if (typeof merged['apiKey'] === 'string' && merged['apiKey'] !== '') {
      merged['apiKey'] = maskKey(merged['apiKey']);
    }
    const pk = merged['providerKeys'];
    if (pk !== undefined && typeof pk === 'object' && !Array.isArray(pk)) {
      const masked: Record<string, string> = {};
      for (const [vendor, key] of Object.entries(pk as Record<string, unknown>)) {
        if (typeof key === 'string') masked[vendor] = maskKey(key);
      }
      merged['providerKeys'] = masked;
    }
    return merged;
  }

  /**
   * 生效的文件级配置：已落盘文件 + UI 覆盖（探测/摘要共用，避免两处取值漂移）。
   * @returns 合并后的文件级配置。
   */
  public fileConfig(): FileConfig {
    return mergeConfigs(configFile.load(this.configFilePath()), this.overrides);
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
    for (const key of PERSISTABLE_KEYS) {
      const value = params[key];
      if (value !== undefined) {
        patch[key] = value;
      }
    }
    this.applyProviderKeyPatch(params, patch);
    await this.applyEnableProvider(params, patch);
    if (Object.keys(patch).length > 0) {
      this.overrides = mergeConfigs(this.overrides, patch as Partial<FileConfig>);
      this.persist();
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
    const list = this.fileConfig().workspaces ?? [];
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
    const saved = this.fileConfig().workspaces ?? [];
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
    configFile.save(path, mergeConfigs(existing, this.overrides));
    this.path = path;
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
    if (typeof vendor !== 'string' || providerPresetOf(vendor) === undefined) return;
    const merged = { ...this.fileConfig().providerKeys };
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
    const preset = providerPresetOf(enable);
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
