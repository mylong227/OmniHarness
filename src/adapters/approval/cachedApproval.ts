import type { ApprovalDecision, ApprovalPort, ApprovalRequest } from '../../ports/approval.js';
import { canonicalizeCommand, canonicalKeyOf } from '../../util/commandCanonicalizer.js';

/** 审批缓存选项。 */
export interface CachedApprovalOptions {
  /** 参与缓存键的工作目录（环境变化即失效）。 */
  readonly cwd?: string;
  /** 策略指纹（审批/沙箱后端名拼接）：策略切换即失效，避免沿用旧裁决。 */
  readonly policyFingerprint?: string;
  /** 缓存上限，超出淘汰最久未用条目。 */
  readonly maxEntries?: number;
  /** 是否缓存 deny（默认缓存；关掉则每次重新问，更安全但更烦人）。 */
  readonly cacheDeny?: boolean;
  /** 需要做命令规范化再入键的工具名（默认 shell）。 */
  readonly commandTools?: readonly string[];
}

/** 默认缓存上限。 */
const DEFAULT_MAX_ENTRIES = 256;

/**
 * 审批缓存装饰器（对标 codex `ApprovalStore` + `with_cached_approval`）。
 *
 * 命中的裁决直接返回，未命中才问内层审批端口并写回缓存。
 * 缓存键 = 工具名 + 规范化命令/路径 + cwd + 策略指纹；四者任一变化即 miss。
 *
 * **进程内存态、不持久化、无 TTL**：与 codex 一致——审批裁决依赖运行时策略，
 * 跨进程复用等于把一次人工确认放大成永久放行，属于权限泄漏。
 */
export class CachedApproval implements ApprovalPort {
  readonly name = 'cached';

  private readonly store = new Map<string, ApprovalDecision>();
  private readonly maxEntries: number;
  private readonly cacheDeny: boolean;
  private readonly commandTools: ReadonlySet<string>;
  private hitCount = 0;
  private missCount = 0;

  constructor(
    private readonly inner: ApprovalPort,
    private readonly options: CachedApprovalOptions = {},
  ) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.cacheDeny = options.cacheDeny ?? true;
    this.commandTools = new Set(options.commandTools ?? ['shell']);
  }

  /** 被装饰的审批端口。 */
  get delegate(): ApprovalPort {
    return this.inner;
  }

  /** 命中次数（可观测/测试用）。 */
  get hits(): number {
    return this.hitCount;
  }

  /** 未命中次数（可观测/测试用）。 */
  get misses(): number {
    return this.missCount;
  }

  /** 当前缓存条目数。 */
  get size(): number {
    return this.store.size;
  }

  /** 裁决请求：命中直接返回，否则问内层后按策略写回。 */
  async decide(request: ApprovalRequest): Promise<ApprovalDecision> {
    const key = this.keyOf(request);
    const cached = this.store.get(key);
    if (cached !== undefined) {
      this.hitCount += 1;
      this.promote(key, cached);
      return cached;
    }
    this.missCount += 1;
    const decision = await this.inner.decide(request);
    if (this.shouldCache(decision)) {
      this.put(key, decision);
    }
    return decision;
  }

  /** 清空缓存（策略变更、会话切换时调用）。 */
  invalidate(): void {
    this.store.clear();
  }

  /** 是否值得缓存：deny 可配置为不缓存。 */
  private shouldCache(decision: ApprovalDecision): boolean {
    return decision === 'allow' || this.cacheDeny;
  }

  /** 写入并按 LRU 淘汰。 */
  private put(key: string, decision: ApprovalDecision): void {
    if (this.store.has(key)) {
      this.store.delete(key);
    }
    this.store.set(key, decision);
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) {
        return;
      }
      this.store.delete(oldest);
    }
  }

  /** 命中后提到最新（保持 LRU 顺序）。 */
  private promote(key: string, decision: ApprovalDecision): void {
    this.store.delete(key);
    this.store.set(key, decision);
  }

  /** 构造缓存键：字段顺序固定，保证序列化稳定。 */
  private keyOf(request: ApprovalRequest): string {
    const target = this.commandTools.has(request.toolName)
      ? canonicalKeyOf(canonicalizeCommand(request.target))
      : request.target;
    return JSON.stringify([
      request.toolName,
      target,
      this.options.cwd ?? '',
      this.options.policyFingerprint ?? '',
    ]);
  }
}
