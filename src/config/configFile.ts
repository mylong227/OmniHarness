import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { profileLoader } from './profileLoader.ts';
import type { SsrfPolicyConfig } from '../security/ssrfPolicy.ts';
import { ConfigError } from './configError.ts';
import { DpapiConfig } from './dpapiConfig.ts';
import { WorkspaceTrust } from './workspaceTrust.ts';
import type { WorkspaceTrustDecision } from '../ports/config/workspaceTrust.ts';
import { TextBom } from '../util/textBom.ts';

export type { FileMcpServer } from '../ports/config/fileMcpServer.ts';

export type { PermissionRuleDecision } from '../ports/config/permissionRuleDecision.ts';

export type { PermissionRuleConfig } from '../ports/config/permissionRuleConfig.ts';

export type { PermissionConfig } from '../ports/config/permissionConfig.ts';

export type { SsrfPolicyConfig };

export type { ProviderPresetConfig } from '../ports/config/providerPresetConfig.ts';

import type { FileConfig } from '../ports/config/fileConfig.ts';
export type { FileConfig };

export type { ModelRouterEntryConfig } from '../ports/config/modelRouterEntryConfig.ts';

export type { ModelRouterConfig } from '../ports/config/modelRouterConfig.ts';

/** 工作区信任选项（只在生产入口传入；缺省不改变既有库/测试行为）。 */
export interface WorkspaceTrustOptions {
  /** 是否本次显式授权（`--trust-workspace`）。 */
  readonly grant: boolean;
  /** 用户级根目录（测试注入）。 */
  readonly userHomedir?: string | undefined;
  /** 决策回调（CLI 用它打印发现式清单）。 */
  readonly onDecision?: ((decision: WorkspaceTrustDecision) => void) | undefined;
}

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
  /**
   * 工作区信任闸。**缺省不启用**（保持库/测试的既有合并语义）；`serve`/`exec` 生产入口
   * 必须传入，否则项目级 `mcpServers`/`approval`/`sandbox`/`baseUrl` 会被直接应用。
   */
  readonly trust?: WorkspaceTrustOptions | undefined;
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
      const raw = TextBom.strip(readFileSync(filePath, 'utf8'));
      return DpapiConfig.open(JSON.parse(raw) as FileConfig);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ConfigError(`配置文件解析失败: ${filePath} —— ${reason}`);
    }
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
    const normalized = ConfigError.normalizeConfig(
      DpapiConfig.seal(cfg) as Record<string, unknown>,
    );
    // 配置文件可能含 apiKey / providerKeys：POSIX 下按 0600 落盘，且对**已存在**文件补 chmod
    //（writeFileSync 的 mode 只在创建时生效）。Windows 上 chmod 语义有限，失败忽略。
    writeFileSync(filePath, JSON.stringify(normalized, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
    try {
      chmodSync(filePath, 0o600);
    } catch {
      // 平台不支持/无权限：不阻断保存（避免把“配置写入”变成因权限位失败）。
    }
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
    const profilePath =
      opts.profile === undefined ? undefined : profileLoader.find(opts.workspace, opts.profile);
    if (opts.profile !== undefined && profilePath === undefined) {
      throw new ConfigError(
        `未找到 profile "${opts.profile}"（查找 ./profiles/<name>.json 与 ~/.omniharness/profiles/<name>.json）`,
      );
    }
    const profileInWorkspace =
      profilePath !== undefined && ConfigFile.isUnder(profilePath, opts.workspace);
    // 先加载（并合并 extends）profile：信任判定需要看**继承后**的权威键，否则父 profile 可绕过。
    const profileLayer = profilePath === undefined ? undefined : profileLoader.load(profilePath);
    const bundleFiles = ConfigFile.bundlePatchFiles(opts.workspace);
    const trust =
      opts.trust === undefined
        ? undefined
        : WorkspaceTrust.resolve({
            workspace: opts.workspace,
            ...(projectPath !== undefined ? { projectPath } : {}),
            ...(profileInWorkspace && profilePath !== undefined ? { profilePath } : {}),
            ...(profileInWorkspace && profileLayer !== undefined ? { profileLayer } : {}),
            bundleFiles,
            ...(opts.userHomedir !== undefined ? { userHomedir: opts.userHomedir } : {}),
            grant: opts.trust.grant,
          });
    if (trust !== undefined) {
      opts.trust?.onDecision?.(trust);
    }

    if (projectPath !== undefined && existsSync(projectPath)) {
      layers.push(WorkspaceTrust.filter(this.readStrict(projectPath), 'project', trust) ?? {});
    }

    // profile 层：仅当指定 --profile 时加载（覆盖项目默认）。用户级 profile 不受工作区信任约束。
    if (profileLayer !== undefined) {
      layers.push(
        profileInWorkspace
          ? (WorkspaceTrust.filter(profileLayer, 'profile', trust) ?? {})
          : profileLayer,
      );
    }

    // bundle 补丁层（G-E 5.2/5.3）：由 `bundle unpack` 写出的 config 覆盖，叠在 profile 之上、
    // 低于显式 env。放在 env 之前插入，使发布单元携带的推荐配置在运行时生效。
    const bundle = ConfigError.loadBundlePatchLayer(opts.workspace);
    layers.push(WorkspaceTrust.filter(bundle, 'bundle', trust) ?? {});

    // 环境变量层：最高优先级（仍低于 CLI 参数）。
    layers.push(ConfigError.readEnvConfig());

    return ConfigError.mergeConfigs(...layers);
  }

  /**
   * 判断路径是否位于工作区内（用于区分项目 profile 与用户 profile）。
   * @param candidate 候选文件。
   * @param workspace 工作区根。
   * @returns 位于工作区内为 true。
   */
  private static isUnder(candidate: string, workspace: string): boolean {
    const root = ConfigFile.realOrResolve(workspace);
    const target = ConfigFile.realOrResolve(candidate);
    const rel = relative(root, target);
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  }

  /**
   * realpath（失败回退 resolve）。Windows 大小写/盘根前缀用词法 startsWith 会误判
   * 「项目 profile 被当成用户 profile」或反之；这里统一走真实路径 + relative。
   * @param path 路径。
   * @returns 规范化绝对路径。
   */
  private static realOrResolve(path: string): string {
    try {
      return realpathSync.native(path);
    } catch {
      return resolve(path);
    }
  }

  /**
   * 列出 bundle 补丁文件（`.omniharness/bundle-patches/*.json`，排序保证指纹稳定）。
   * @param workspaceDir 工作区根。
   * @returns 绝对路径数组；目录不存在为空。
   */
  private static bundlePatchFiles(workspaceDir: string): readonly string[] {
    const dir = join(workspaceDir, '.omniharness', 'bundle-patches');
    if (!existsSync(dir)) {
      return [];
    }
    try {
      return readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .sort()
        .map((name) => join(dir, name));
    } catch {
      return [];
    }
  }

  /** 读文件并严格归一化（未知 key / 枚举越界 / 类型错误抛 ConfigError）。 */
  private readStrict(filePath: string): FileConfig {
    let raw: string;
    try {
      // 与 ConfigFile.load 同一条 BOM 例外（两层入口必须一致，否则「单文件能读、分层读不了」）。
      raw = TextBom.strip(readFileSync(filePath, 'utf8'));
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
    const normalized = ConfigError.normalizeConfig(parsed as Record<string, unknown>);
    try {
      return DpapiConfig.open(normalized);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ConfigError(`配置文件 ${filePath} 凭据解密失败: ${reason}`);
    }
  }
}

// ---- 组合根门面：默认加载器实例（调用点以 `configFile.xxx` 零构造复用） ----
/** 默认配置文件加载器实例（无状态）。 */
export const configFile = new ConfigFile();
