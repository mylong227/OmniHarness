import { homedir } from 'node:os';
import { join } from 'node:path';
import { configFile, type FileConfig } from '../../config/configFile.ts';
import { PortablePath } from '../../util/portablePath.ts';
import { OmniHome } from '../../util/omniHome.ts';

/**
 * 用户级配置（`~/.omniharness/omniharness.json`）的专属读写通道：本机运行态 + 私密凭据。
 *
 * **为什么独立成类**（2026-10-13 起，用户口径："都固定保存到 ~/.omniharness/ 下"）：
 * 写路径**只有一个**——用户级文件；项目级 `omniharness.json` 在本仓只读不写（手写的仍作
 * 分层覆盖层生效）。本类承载三类写入中与「项目设置」无关的两类：
 *  - 本机运行态（{@link LOCAL_STATE_KEYS}：workspace / workspaces）——"我上次在用哪个项目"
 *    属于本机状态，落项目文件会随项目上传/换机器失效；
 *  - 私密凭据（{@link SECRET_KEYS}：apiKey / providerKeys）——落项目文件曾导致重启换工作区后
 *    读到另一份无 Key 文件，表现为「设置全被重置」（fail-closed「厂商未配置」）。
 * 与「其余设置」的写入（`ServerConfigStore.persist`）合并写进**同一份**用户级文件，
 * 先来后到互不覆盖；合并一律「读既有文件 → 浅合并 → 写回」，绝不整文件覆盖。
 */
export class UserLevelConfigStore {
  /**
   * **本机运行态**键：只落用户级配置，绝不写进项目文件。
   */
  public static readonly LOCAL_STATE_KEYS: readonly string[] = ['workspace', 'workspaces'];

  /**
   * **私密凭据**键：只落用户级配置，绝不写进项目文件。
   *
   * 为什么必须与项目文件分开（2026-10-13 真机缺陷，用户报「每次重启 Key 全被重置」）：
   * Key 原先随 persist 落进**启动工作区**的项目级 `omniharness.json`；重启时 serve 的工作区
   * 根按用户级配置重新解析（用户级文件的 `workspace`），一旦与上次启动的工作区不同（UI 切过
   * 项目 / 换了启动目录），项目层读到的就是**另一份没有 Key 的文件** ⇒ fail-closed（「厂商
   * DeepSeek 未配置 API Key」）→ 模型回落 mock，表现为「设置全被重置」。分层加载
   * （`configFile.loadLayered`）本就先读用户级，Key 落用户级后**跨工作区、跨启动目录恒可见**
   * ——这也是 2026-10-06 用户口径「私密配置只落本地、不随项目上传」的应有之义。
   */
  public static readonly SECRET_KEYS: readonly string[] = ['apiKey', 'providerKeys'];

  /** 用户级配置的家目录覆盖（缺省 `os.homedir()`；单测在临时目录里隔离真实机器）。 */
  private readonly home: string | undefined;

  /**
   * @param userHomedir 用户级配置的家目录覆盖（缺省真实家目录）
   */
  public constructor(userHomedir?: string | undefined) {
    this.home = userHomedir;
  }

  /**
   * 用户级配置路径（本机运行态与凭据的家）。
   * @returns 用户级 `omniharness.json` 的绝对路径。
   */
  public path(): string {
    return join(OmniHome.dir(this.home), configFile.FILE_NAME);
  }

  /**
   * 用户级配置内容。
   * @returns 用户级配置（文件不存在时为空配置）。
   */
  public load(): FileConfig {
    return configFile.load(this.path());
  }

  /**
   * 把「当前项目 / 项目列表」写进用户级配置。
   *
   * **为什么必须与项目文件分开写**（2026-10-06 用户口径）：`workspace` 是"我上次在用哪个项目"
   * 的**本机运行态**，不是项目自身的设置。它一旦写进项目里的 `omniharness.json`：
   * ① 会随项目**上传/提交**出去（用户在别的机器上 clone 后会被带到别人的项目路径上）；
   * ② 换台机器/换个启动目录就指向不存在的路径。
   * 写回**可移植形态**：家目录下的路径压成 `~/…`（用户口径："无论何时何地何种机器都能正确读取
   * 为一套配置"）。家目录之外的保持绝对路径——绝不臆造一个在别处不成立的路径。
   * @param overrides UI 覆盖态（只取本机运行态键）。
   * @param clearedKeys 本次被显式清除的键（`null` = 清除，与项目文件同口径：merge 只覆盖不删除）。
   * @returns 无返回值。
   */
  public persistLocalState(overrides: Partial<FileConfig>, clearedKeys: readonly string[]): void {
    const keys = UserLevelConfigStore.LOCAL_STATE_KEYS;
    const home = this.home ?? homedir();
    const patch: Record<string, unknown> = {};
    for (const key of keys) {
      const value = (overrides as Record<string, unknown>)[key];
      if (value === undefined) continue;
      patch[key] = Array.isArray(value)
        ? value.map((entry) =>
            typeof entry === 'string' ? PortablePath.compact(entry, home) : entry,
          )
        : typeof value === 'string'
          ? PortablePath.compact(value, home)
          : value;
    }
    if (Object.keys(patch).length === 0 && !keys.some((k) => clearedKeys.includes(k))) {
      return;
    }
    const path = this.path();
    const existing = configFile.load(path);
    const merged = { ...existing, ...patch } as Record<string, unknown>;
    for (const key of clearedKeys) {
      if (keys.includes(key)) delete merged[key];
    }
    configFile.save(path, merged as Partial<FileConfig>);
  }

  /**
   * 把私密凭据（`apiKey` / `providerKeys`）写进用户级配置。
   *
   * 与 {@link persistLocalState} 同一套口径：合并进既有用户级文件（绝不整文件覆盖，用户手写在
   * 用户级里的其他键不能丢）；`clearedKeys` 中的凭据键在此层删除（merge 只覆盖不删除）。
   * 重启后无论工作区解析到哪个目录，分层加载都先读这份 ⇒ Key 不再随工作区「被重置」。
   * @param overrides UI 覆盖态（只取凭据键）。
   * @param clearedKeys 本次被显式清除的键。
   * @returns 无返回值。
   */
  public persistSecrets(overrides: Partial<FileConfig>, clearedKeys: readonly string[]): void {
    const secretEntries = Object.entries(overrides).filter(([key]) =>
      UserLevelConfigStore.SECRET_KEYS.includes(key),
    );
    const clearedSecrets = clearedKeys.filter((key) =>
      UserLevelConfigStore.SECRET_KEYS.includes(key),
    );
    if (secretEntries.length === 0 && clearedSecrets.length === 0) {
      return;
    }
    const path = this.path();
    const existing = configFile.load(path);
    const merged = { ...existing, ...Object.fromEntries(secretEntries) } as Record<string, unknown>;
    for (const key of clearedSecrets) {
      delete merged[key];
    }
    configFile.save(path, merged as Partial<FileConfig>);
  }
}
