import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { profileLoader } from './profileLoader.js';
import type { SsrfPolicyConfig } from '../security/ssrfPolicy.js';
import { ConfigError } from './configError.js';

export type { FileMcpServer } from '../ports/config/fileMcpServer.js';

export type { PermissionRuleDecision } from '../ports/config/permissionRuleDecision.js';

export type { PermissionRuleConfig } from '../ports/config/permissionRuleConfig.js';

export type { PermissionConfig } from '../ports/config/permissionConfig.js';

export type { SsrfPolicyConfig };

export type { ProviderPresetConfig } from '../ports/config/providerPresetConfig.js';

import type { FileConfig } from '../ports/config/fileConfig.js';
export type { FileConfig };

export type { ModelRouterEntryConfig } from '../ports/config/modelRouterEntryConfig.js';

export type { ModelRouterConfig } from '../ports/config/modelRouterConfig.js';

/** loadLayered 的参数。 */
export interface LayeredOptions {
  readonly workspace: string;
  /** 显式配置文件路径（--config），优先于向上查找。 */
  readonly configPath?: string | undefined;
  /** 选中的 profile 名（--profile），PATH 在 profiles/ 下查找。 */
  readonly profile?: string | undefined;
  /**
   * 用户层根目录覆盖（缺省取真实 home）。测试注入隔离 home 用——否则真实机器上的
   * `~/.omniharness/omniharness.json` 会渗进断言（非封闭测试）。
   */
  readonly userHomedir?: string | undefined;
}

/** 配置文件加载器：omniharness.json，向上逐级查找（无隐式状态，默认实例见文件末尾）。 */
export class ConfigFile {
  /** 配置文件固定名。 */
  public readonly FILE_NAME = 'omniharness.json';

  /** 从目录向上查找配置文件。 */
  public find(startDir: string): string | undefined {
    let current = startDir;
    while (true) {
      const candidate = join(current, this.FILE_NAME);
      if (existsSync(candidate)) {
        return candidate;
      }
      const parent = dirname(current);
      if (parent === current) {
        return undefined;
      }
      current = parent;
    }
  }

  /**
   * 加载并解析配置文件。
   *
   * 区分两种情形（fail-closed）：
   * - 文件不存在 → 返回空配置 `{}`（合法空配置，调用方与 `cliSystem.test` 依赖此语义）；
   * - 文件存在但解析失败（非法 JSON / 编码错误）→ 抛 `ConfigError` 暴露，不再静默回退 `{}`
   *   掩盖错误（否则生产环境配置写坏也无症状，且 UI 覆盖会悄悄覆盖掉整份文件）。
   *
   * **BOM 例外（2026-10-06 真机踩到）**：开头若有 UTF-8 BOM（`EF BB BF`）先剥掉再 parse。
   * 为什么不能算语法错误：BOM 是**编码层**标记而非内容，而 Windows 上极常见的写入方都会带它
   * （PowerShell `Set-Content -Encoding UTF8`、记事本"另存为 UTF-8"、部分编辑器），实测它会让
   * 本仓**所有**入口 fail-closed（serve 直接启动失败），用户看到的是"配置明明是对的却起不来"。
   * 剥 BOM 之后**其余一切照旧严格**：真正的语法错误仍然 fail-closed 报错。
   * @param filePath 配置文件路径
   * @returns 解析后的配置；文件不存在为空配置
   */
  public load(filePath: string): FileConfig {
    if (!existsSync(filePath)) {
      return {};
    }
    try {
      const raw = ConfigFile.stripBom(readFileSync(filePath, 'utf8'));
      return JSON.parse(raw) as FileConfig;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ConfigError(`配置文件解析失败: ${filePath} —— ${reason}`);
    }
  }

  /**
   * 剥掉开头的 UTF-8 BOM（`\uFEFF`）。见 {@link ConfigFile.load} 的 BOM 例外说明。
   * @param text 原始文本。
   * @returns 去掉起始 BOM 的文本（无 BOM 时原样）。
   */
  private static stripBom(text: string): string {
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  }

  /**
   * 写回配置文件（落盘）：先归一化校验（未知 key / 枚举越界 / 类型错误 fail-closed 抛 ConfigError），
   * 目录不存在自动创建，输出 pretty JSON。供 AppServer.config.update 持久化 UI 设置。
   
   * @returns 无返回值。
   */
  public save(filePath: string, cfg: FileConfig): void {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const normalized = ConfigError.normalizeConfig(cfg as Record<string, unknown>);
    writeFileSync(filePath, JSON.stringify(normalized, null, 2) + '\n', 'utf8');
  }

  /**
   * 分层加载并严格合并配置（#G6）：
   *   用户级 ~/.omniharness/omniharness.json → 项目级 omniharness.json → profile → 环境变量
   * 各层（除环境变量层，它天然只含已知 key）经 normalizeConfig 严格校验，未知 key / 枚举越界 / 类型错误
   * 一律 fail-closed 抛 ConfigError。合并语义为「非零值覆盖」，CLI 参数在更上层（parseArgs）继续覆盖。
   */
  public loadLayered(opts: LayeredOptions): FileConfig {
    const layers: Partial<FileConfig>[] = [];

    // 用户级：固定路径 ~/.omniharness/omniharness.json（若存在；userHomedir 供测试隔离注入）。
    const userPath = join(opts.userHomedir ?? homedir(), '.omniharness', 'omniharness.json');
    if (existsSync(userPath)) {
      layers.push(this.readStrict(userPath));
    }

    // 项目级：显式 --config 优先，否则向上查找。
    const projectPath = opts.configPath ?? this.find(opts.workspace);
    if (projectPath !== undefined && existsSync(projectPath)) {
      layers.push(this.readStrict(projectPath));
    }

    // profile 层：仅当指定 --profile 时加载（覆盖项目默认）。
    if (opts.profile !== undefined) {
      const profilePath = profileLoader.find(opts.workspace, opts.profile);
      if (profilePath === undefined) {
        throw new ConfigError(
          `未找到 profile "${opts.profile}"（查找 ./profiles/<name>.json 与 ~/.omniharness/profiles/<name>.json）`,
        );
      }
      layers.push(profileLoader.load(profilePath));
    }

    // bundle 补丁层（G-E 5.2/5.3）：由 `bundle unpack` 写出的 config 覆盖，叠在 profile 之上、
    // 低于显式 env。放在 env 之前插入，使发布单元携带的推荐配置在运行时生效。
    layers.push(ConfigError.loadBundlePatchLayer(opts.workspace));

    // 环境变量层：最高优先级（仍低于 CLI 参数）。
    layers.push(ConfigError.readEnvConfig());

    return ConfigError.mergeConfigs(...layers);
  }

  /** 读文件并严格归一化（未知 key / 枚举越界 / 类型错误抛 ConfigError）。 */
  private readStrict(filePath: string): FileConfig {
    let raw: string;
    try {
      // 与 ConfigFile.load 同一条 BOM 例外（两层入口必须一致，否则「单文件能读、分层读不了」）。
      raw = ConfigFile.stripBom(readFileSync(filePath, 'utf8'));
    } catch (err) {
      throw new ConfigError(`无法读取配置文件 ${filePath}: ${(err as Error).message}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new ConfigError(`配置文件 ${filePath} 不是合法 JSON: ${(err as Error).message}`);
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw new ConfigError(`配置文件 ${filePath} 顶层应为对象`);
    }
    return ConfigError.normalizeConfig(parsed as Record<string, unknown>);
  }
}

// ---- 组合根门面：默认加载器实例（调用点以 `configFile.xxx` 零构造复用） ----
/** 默认配置文件加载器实例（无状态）。 */
export const configFile = new ConfigFile();
