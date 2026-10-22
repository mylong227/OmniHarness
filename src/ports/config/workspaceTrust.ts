/**
 * 工作区信任决策（端口层，纯类型）。
 *
 * 背景：项目级 `omniharness.json` 与 `.omniharness/bundle-patches/*.json` 是**工作区输入**，
 * 可声明 `mcpServers`（启动即 spawn）、`approval`/`sandbox`（降权）、`baseUrl`（改变凭据去向）。
 * 本类型是「这份工作区配置是否被信任、哪些键因此被忽略」的只读结论，供 CLI/UI 展示与
 * `ConfigFile.loadLayered` 过滤使用；不含 IO，便于判据单测。
 *
 * 与插件签名/进程隔离的关系：正交。插件签名管「制品」，本决策管「工作区配置」。
 */

/** 信任模式：trusted 应用工作区权威键；restricted 只应用只读语义键。 */
export type WorkspaceTrustMode = 'trusted' | 'restricted';

/** 被忽略键的来源层。 */
export type WorkspaceTrustSource = 'project' | 'profile' | 'bundle';

/** 忽略原因：未信任工作区，或触碰不可降级的策略地板。 */
export type WorkspaceTrustIgnoreReason = 'untrusted' | 'policy-floor';

/** 一条被忽略的工作区配置。 */
export interface WorkspaceTrustIgnoredKey {
  /** 配置键（顶层 key）。 */
  readonly key: string;
  /** 来源层。 */
  readonly source: WorkspaceTrustSource;
  /** 忽略原因。 */
  readonly reason: WorkspaceTrustIgnoreReason;
  /** 人类可读摘要（不回显密钥值）。 */
  readonly summary: string;
}

/** 工作区信任决策。 */
export interface WorkspaceTrustDecision {
  /** 最终模式。 */
  readonly mode: WorkspaceTrustMode;
  /** 工作区绝对路径（展示用；信任存储的键是 realpath）。 */
  readonly workspace: string;
  /** 工作区配置指纹（项目配置 + profile + bundle patch 的内容哈希）。 */
  readonly configHash: string;
  /** 工作区请求的权威键（无论是否被信任，用于发现式清单）。 */
  readonly requested: readonly WorkspaceTrustIgnoredKey[];
  /** 实际被忽略的键（restricted 下为全部权威键；trusted 下只看 policy floor）。 */
  readonly ignored: readonly WorkspaceTrustIgnoredKey[];
  /** 是否本次显式授权（`--trust-workspace`）并已写入信任存储。 */
  readonly granted: boolean;
  /** 信任存储读写告警（损坏/写失败等），调用方可原样打印。 */
  readonly warnings: readonly string[];
}
