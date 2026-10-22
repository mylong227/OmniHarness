/**
 * 工作区信任策略（restricted 默认 + policy floor + TOFU）。
 *
 * ## 为什么需要
 *
 * 配置分层会合并**工作区输入**：项目级 `omniharness.json`、项目 `profiles/*.json`、
 * `.omniharness/bundle-patches/*.json`。这些层可以声明：
 * - `mcpServers`：`serve` / `exec` 启动时直接 spawn 子进程；
 * - `approval` / `sandbox` / `escalation`：把审批与隔离降到最低；
 * - `baseUrl` / `providerKeys`：改变凭据去向；
 * - `permission` / `ssrfPolicy` / `rbac`：放宽工具与出站策略。
 *
 * 于是「clone 一个仓库 → npm start」的信任边界，等于「执行仓库里的配置」。本类把这条边界
 * 显式化：未信任工作区只应用**只读语义键**（model/reasoning/storage 等），权威键逐条忽略并
 * 打印发现式清单；用户显式 `--trust-workspace` 后写入用户级 trust.json（TOFU 指纹）。
 *
 * ## 不做什么
 *
 * - 不替代插件签名/进程隔离：本类只管「工作区配置」，插件签名管「插件制品」；
 * - 不防本机恶意软件：能改用户级 trust.json 的人已经拥有该用户权限；
 * - 不做交互式 y/N：`serve` 是常驻进程，交互式确认会挂住自动化；默认 restricted +
 *   显式旗标是可脚本化的 fail-closed。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { FileConfig } from '../ports/config/fileConfig.ts';
import type {
  WorkspaceTrustDecision,
  WorkspaceTrustIgnoredKey,
  WorkspaceTrustSource,
} from '../ports/config/workspaceTrust.ts';
import { WorkspaceTrustStore } from './workspaceTrustStore.ts';
import { DpapiConfig } from './dpapiConfig.ts';
import { ConfigKeyAliases } from './configKeyAliases.ts';
import { TextBom } from '../util/textBom.ts';

/** 解析参数。 */
export interface WorkspaceTrustResolveOptions {
  /** 工作区根。 */
  readonly workspace: string;
  /** 项目级配置文件路径（缺省不读）。 */
  readonly projectPath?: string | undefined;
  /** 选中的 profile 路径（项目级或用户级；由调用方判定来源）。 */
  readonly profilePath?: string | undefined;
  /**
   * 已由 `profileLoader` 合并 `extends` 后的 profile 层。
   *
   * 为什么由调用方传入而不是本类 import `profileLoader`：那会形成
   * `configFile → workspaceTrust → profileLoader → configFile` 的依赖环（arch gate 实测新增 1 环）。
   * 调用方本来就要加载 profile，传入合并结果既避免重复读，也保住端口/分层方向。
   */
  readonly profileLayer?: Partial<FileConfig> | undefined;
  /** bundle 补丁文件清单（绝对路径）。 */
  readonly bundleFiles?: readonly string[] | undefined;
  /** 用户级根目录（测试注入）。 */
  readonly userHomedir?: string | undefined;
  /** 是否显式授权（`--trust-workspace`）。 */
  readonly grant: boolean;
  /** 授权时间（测试注入受控时钟）。 */
  readonly now?: Date | undefined;
}

/** 权威键 → 摘要生成器；未列出的键不参与信任过滤。 */
const AUTHORITY_SUMMARIES: Readonly<Record<string, (value: unknown) => string>> = {
  mcpServers: (value) => {
    const servers = Array.isArray(value) ? value : [];
    const names = servers
      .map((entry) =>
        typeof entry === 'object' && entry !== null
          ? String((entry as Record<string, unknown>)['name'] ?? '?')
          : '?',
      )
      .slice(0, 5);
    return `${String(servers.length)} 个 server${names.length > 0 ? `：${names.join(', ')}` : ''}`;
  },
  approval: (value) => String(value),
  sandbox: (value) => String(value),
  escalation: (value) => String(value),
  elevatedSandbox: (value) => String(value),
  baseUrl: (value) => String(value),
  apiKey: () => '<redacted>',
  apiKeyDpapi: () => '<redacted>',
  providerKeys: (value) => {
    const keys =
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.keys(value as Record<string, unknown>)
        : [];
    return keys.length > 0 ? `键：${keys.join(', ')}` : '已声明';
  },
  providerKeysDpapi: () => '已声明（加密）',
  providerPresets: (value) => `${Array.isArray(value) ? String(value.length) : '?'} 个厂商预设`,
  permission: () => '工具权限规则（可放宽 allow/deny）',
  ssrfPolicy: () => '出站策略（可放宽 SSRF 白名单）',
  rbac: () => '角色门禁（可改变权限矩阵）',
  pluginProfile: (value) => String(value),
  capability: () => '能力协议段（可注册/提升资产）',
  a2a: () => 'A2A 服务端段（可开启外部监听）',
  skills: (value) => `${Array.isArray(value) ? String(value.length) : '?'} 个内联技能`,
  modelRouter: () => '模型路由（可改变端点/凭据去向）',
  decisionEngine: () => '本地决策引擎段（可改变路由/行为）',
  evolutionRlvr: () => '进化/RLVR 段（可改变资产晋升）',
  longTermMemoryKeyFile: () => '记忆密钥文件路径',
  storageDir: (value) => `存储目录重定向：${String(value)}`,
  media: () => '媒体工具路径（ffmpeg/ffprobe/extraSearchPaths，可执行外部程序）',
  // 工作区根是**运行时边界**：项目级配置若能改它，就能把沙箱/工具根指向任意目录。
  workspace: (value) => `工程级工作区根：${String(value)}`,
  workspaces: (value) => `${Array.isArray(value) ? String(value.length) : '?'} 个工作区列表`,
  costBudgetUsd: (value) => `成本预算：${String(value)}`,
  costBudgetSoftRatio: (value) => `软预算比例：${String(value)}`,
  costBudgetOnExceed: (value) => `超预算行为：${String(value)}`,
  modelCircuitBreaker: (value) => `模型熔断开关：${String(value)}`,
  modelCircuitBreakerThreshold: (value) => `熔断阈值：${String(value)}`,
  modelCircuitBreakerOpenMs: (value) => `熔断打开时长：${String(value)}`,
  longTermMemoryEncryption: (value) => `长期记忆加密：${String(value)}`,
};

/** policy floor：即使信任工作区，这些「降权值」也只能由 CLI 显式给出。 */
const POLICY_FLOOR: Readonly<Record<string, readonly string[]>> = {
  approval: ['auto'],
  sandbox: ['passthrough'],
  escalation: ['auto'],
  elevatedSandbox: ['passthrough'],
};

/**
 * 同族键：明文与 DPAPI 密文是同一份凭据的两种形态，过滤时必须一起删。
 * 否则 `readStrict` 解出 `apiKey`、决策只看到 `apiKeyDpapi` 时会漏掉明文。
 */
const KEY_FAMILIES: Readonly<Record<string, readonly string[]>> = {
  apiKey: ['apiKey', 'apiKeyDpapi'],
  apiKeyDpapi: ['apiKey', 'apiKeyDpapi'],
  providerKeys: ['providerKeys', 'providerKeysDpapi'],
  providerKeysDpapi: ['providerKeys', 'providerKeysDpapi'],
};

/**
 * 未信任工作区仍可应用的**只读语义键**（其余键一律按权威键处理）。
 *
 * 这张表是「分类全覆盖」判据的另一半：`tests/unit/workspaceTrust.test.ts` 会拿
 * `ConfigError.knownKeys()` 逐键核对 `SAFE_KEYS ∪ AUTHORITY_SUMMARIES`，新增配置键
 * 若没归类就直接变红——避免「未来加了一个可执行键，信任闸不认识它」的静默绕过。
 */
const SAFE_KEYS: ReadonlySet<string> = new Set([
  'modelAdapter',
  'model',
  'reasoning',
  'storageAdapter',
  'maxSteps',
  'contextWindow',
  'locale',
  'extends',
]);

/**
 * 工作区信任策略（纯逻辑 + 仅读配置文件的 IO）。
 */
export class WorkspaceTrust {
  /**
   * 该配置键是否已被「安全/权威」分类（供全覆盖判据使用）。
   * @param key 顶层配置键。
   * @returns 已归类为 true。
   */
  public static isClassified(key: string): boolean {
    return SAFE_KEYS.has(key) || key in AUTHORITY_SUMMARIES;
  }

  /**
   * 计算信任决策。
   * @param options 工作区/路径/授权信息。
   * @returns 决策（含 requested/ignored 与告警）。
   */
  public static resolve(options: WorkspaceTrustResolveOptions): WorkspaceTrustDecision {
    const store = new WorkspaceTrustStore(options.userHomedir);
    const configHash = WorkspaceTrust.hashOf(options);
    const check = store.check(options.workspace, configHash);
    const warnings: string[] = [...check.warnings];
    let granted = false;
    if (options.grant) {
      const result = store.grant(options.workspace, configHash, options.now);
      warnings.push(...result.warnings);
      // 写盘失败 ⇒ 本次也按未信任处理（不制造「启动 trusted、RPC restricted」的不一致）。
      granted = result.ok;
    }
    const trusted = granted || check.trusted;
    const layers = WorkspaceTrust.readLayers(options);
    const requested = layers.flatMap((layer) =>
      WorkspaceTrust.entriesOf(layer.source, layer.value, 'untrusted'),
    );
    const ignored = trusted
      ? layers.flatMap((layer) =>
          WorkspaceTrust.entriesOf(layer.source, layer.value, 'policy-floor'),
        )
      : requested;
    return {
      mode: trusted ? 'trusted' : 'restricted',
      workspace: resolve(options.workspace),
      configHash,
      requested,
      ignored,
      granted,
      warnings,
    };
  }

  /**
   * 按决策过滤一层配置（只删被忽略的顶层键；user/env 层不得传入）。
   * @param layer 原始层。
   * @param source 层来源（project/profile/bundle）。
   * @param decision 信任决策。
   * @returns 过滤后的层（无变化时返回原对象）。
   */
  public static filter(
    layer: Partial<FileConfig> | undefined,
    source: WorkspaceTrustSource,
    decision: WorkspaceTrustDecision | undefined,
  ): Partial<FileConfig> | undefined {
    if (layer === undefined || decision === undefined) {
      return layer;
    }
    const keys = new Set(
      decision.ignored.filter((entry) => entry.source === source).map((entry) => entry.key),
    );
    // 以**实际层内容**再兜底一次，而不是只信决策时的快照：
    // - restricted：删掉层里所有权威键（覆盖 TOCTOU / 决策漏看的别名形态）；
    // - trusted：删掉层里触碰 policy floor 的降权值。
    // decision.ignored 仍保留为可读报告（键/来源/原因），但不作为安全性的唯一依据。
    const actual = layer as Record<string, unknown>;
    for (const [rawKey, value] of Object.entries(actual)) {
      const key = ConfigKeyAliases.canonical(rawKey);
      if (decision.mode === 'restricted' && key in AUTHORITY_SUMMARIES) {
        keys.add(key);
      }
      if (decision.mode === 'trusted') {
        const floor = POLICY_FLOOR[key];
        if (floor !== undefined && floor.includes(String(value))) {
          keys.add(key);
        }
      }
    }
    if (keys.size === 0) {
      return layer;
    }
    const out: Record<string, unknown> = { ...actual };
    for (const key of keys) {
      for (const variant of KEY_FAMILIES[key] ?? [key]) {
        delete out[variant];
      }
    }
    return out as Partial<FileConfig>;
  }

  /**
   * 生成人类可读的发现式清单（无内容时返回空数组，避免每次启动刷屏）。
   * @param decision 信任决策。
   * @returns 行数组。
   */
  public static describe(decision: WorkspaceTrustDecision): readonly string[] {
    const lines: string[] = [];
    if (decision.warnings.length > 0) {
      lines.push(...decision.warnings.map((warning) => `[workspace-trust] ${warning}`));
    }
    if (decision.ignored.length === 0) {
      if (decision.granted) {
        lines.push(`[workspace-trust] 已信任工作区：${decision.workspace}`);
      }
      return lines;
    }
    lines.push(
      decision.mode === 'trusted'
        ? `[workspace-trust] 已信任工作区（${decision.workspace}），但以下降权配置被策略地板拒绝：`
        : `[workspace-trust] 工作区未信任（${decision.workspace}）；以下配置已忽略：`,
    );
    for (const entry of decision.ignored) {
      const reason = entry.reason === 'policy-floor' ? '策略地板' : '未信任';
      lines.push(`  - ${entry.key} = ${entry.summary}（${entry.source}，${reason}）`);
    }
    if (decision.mode === 'restricted') {
      lines.push('  确认可信后重跑：omniharness serve --trust-workspace（或 exec 同名旗标）');
      lines.push('  信任记录：~/.omniharness/trust.json；配置变化会自动失效');
    }
    return lines;
  }

  /**
   * 计算工作区配置指纹（项目配置 + 项目 profile 目录 + bundle patches）。
   * @param options 路径信息。
   * @returns sha256 十六进制。
   */
  private static hashOf(options: WorkspaceTrustResolveOptions): string {
    const files = new Set<string>();
    if (options.projectPath !== undefined) {
      files.add(resolve(options.projectPath));
    }
    if (options.profilePath !== undefined) {
      files.add(resolve(options.profilePath));
      for (const sibling of WorkspaceTrust.siblingJsonFiles(options.profilePath)) {
        files.add(sibling);
      }
    }
    for (const file of options.bundleFiles ?? []) {
      files.add(resolve(file));
    }
    const hash = createHash('sha256');
    hash.update('omniharness-workspace-trust-v1\0');
    hash.update(WorkspaceTrustStore.normalize(options.workspace));
    for (const file of [...files].sort()) {
      hash.update('\0');
      hash.update(file);
      hash.update('\0');
      try {
        hash.update(readFileSync(file));
      } catch {
        hash.update('<missing>');
      }
    }
    // 合并后的 profile 也要进指纹：`extends` 可能指向工作区外（`../x.json`），
    // 仅哈希同目录文件会漏掉父链内容变化。
    if (options.profileLayer !== undefined) {
      hash.update('\0profile-layer\0');
      hash.update(JSON.stringify(options.profileLayer));
    }
    return hash.digest('hex');
  }

  /**
   * 读取工作区层（项目/profile/bundle），用于发现清单与 policy floor 检测。
   * @param options 路径信息。
   * @returns 层数组（顺序固定）。
   */
  private static readLayers(
    options: WorkspaceTrustResolveOptions,
  ): readonly { source: WorkspaceTrustSource; value: Record<string, unknown> }[] {
    const layers: { source: WorkspaceTrustSource; value: Record<string, unknown> }[] = [];
    const project = WorkspaceTrust.readJson(options.projectPath);
    if (project !== undefined) {
      layers.push({ source: 'project', value: project });
    }
    if (options.profileLayer !== undefined) {
      layers.push({
        source: 'profile',
        value: options.profileLayer as unknown as Record<string, unknown>,
      });
    }
    for (const file of options.bundleFiles ?? []) {
      const value = WorkspaceTrust.readBundleLayer(file);
      if (value !== undefined) {
        layers.push({ source: 'bundle', value });
      }
    }
    return layers;
  }

  /**
   * 把 bundle patch 文件展开为 `{ key: value }` 形态（其磁盘结构是 `{ patches: [...] }`）。
   * @param file 补丁文件路径。
   * @returns 展开后的配置对象；非法/无 patches 返回 undefined。
   */
  private static readBundleLayer(file: string): Record<string, unknown> | undefined {
    const raw = WorkspaceTrust.readRawJson(file);
    if (raw === undefined || !Array.isArray(raw['patches'])) {
      return undefined;
    }
    const out: Record<string, unknown> = {};
    for (const entry of raw['patches'] as readonly unknown[]) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as Record<string, unknown>;
      if (typeof record['key'] === 'string') {
        out[ConfigKeyAliases.canonical(record['key'])] = record['value'];
      }
    }
    try {
      return DpapiConfig.open(out as unknown as FileConfig) as unknown as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }

  /**
   * 从一层配置里挑出权威键（或 policy floor 违规项）。
   * @param source 层来源。
   * @param layer 层内容。
   * @param reason 过滤原因（untrusted = 全部权威键；policy-floor = 仅违规值）。
   * @returns 条目数组。
   */
  private static entriesOf(
    source: WorkspaceTrustSource,
    layer: Record<string, unknown>,
    reason: 'untrusted' | 'policy-floor',
  ): WorkspaceTrustIgnoredKey[] {
    const out: WorkspaceTrustIgnoredKey[] = [];
    for (const [rawKey, value] of Object.entries(layer)) {
      const key = ConfigKeyAliases.canonical(rawKey);
      if (!(key in AUTHORITY_SUMMARIES)) continue;
      const floor = POLICY_FLOOR[key];
      if (reason === 'policy-floor') {
        if (floor === undefined || !floor.includes(String(value))) {
          continue;
        }
      }
      out.push({
        key,
        source,
        reason,
        summary: AUTHORITY_SUMMARIES[key]?.(value) ?? String(value),
      });
    }
    return out;
  }

  /**
   * 读取并归一化一层 JSON（BOM + 键别名 + DPAPI 解密）。
   *
   * 必须与 `ConfigFile.readStrict` 走同一条归一化：否则 BOM/`base_url`/`apiKeyDpapi`
   * 会出现「实际加载了、决策没看见」的绕过（2026-10-22 评审实测）。
   * 缺失/非法返回 undefined；真正的 fail-closed 由随后的 `readStrict` 负责。
   * @param file 文件路径。
   * @returns 归一化后的对象或 undefined。
   */
  private static readJson(file: string | undefined): Record<string, unknown> | undefined {
    const parsed = WorkspaceTrust.readRawJson(file);
    if (parsed === undefined) {
      return undefined;
    }
    try {
      const canonical: Record<string, unknown> = {};
      for (const [rawKey, value] of Object.entries(parsed)) {
        canonical[ConfigKeyAliases.canonical(rawKey)] = value;
      }
      return DpapiConfig.open(canonical as unknown as FileConfig) as unknown as Record<
        string,
        unknown
      >;
    } catch {
      return undefined;
    }
  }

  /**
   * 读取原始 JSON 对象（只剥 BOM；不做键归一化/解密）。
   * @param file 文件路径。
   * @returns 对象或 undefined。
   */
  private static readRawJson(file: string | undefined): Record<string, unknown> | undefined {
    if (file === undefined || !existsSync(file)) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(TextBom.strip(readFileSync(file, 'utf8'))) as unknown;
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 列出 profile 同目录下的 JSON 文件（含父 profile；内容变化也会让指纹失效）。
   * @param profilePath profile 路径。
   * @returns 绝对路径数组（不含自身）。
   */
  private static siblingJsonFiles(profilePath: string): readonly string[] {
    try {
      const dir = dirname(resolve(profilePath));
      return readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => join(dir, name));
    } catch {
      return [];
    }
  }
}
