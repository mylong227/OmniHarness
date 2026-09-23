import { TOOL_NAMES } from '../../ports/tool/toolNames.js';
import type {
  ApprovalDecision,
  ApprovalPort,
  ApprovalRequest,
} from '../../ports/runtime/approval.js';
import { canonicalizeCommand, canonicalKeyOf } from '../../util/commandCanonicalizer.js';

/** 审批缓存选项。 */
export interface CachedApprovalOptions {
  /** 参与缓存键的工作目录（环境变化即失效）。 */
  readonly cwd?: string | undefined;
  /** 策略指纹（审批/沙箱后端名拼接）：策略切换即失效，避免沿用旧裁决。 */
  readonly policyFingerprint?: string | undefined;
  /** 缓存上限，超出淘汰最久未用条目。 */
  readonly maxEntries?: number | undefined;
  /** 是否缓存 deny（默认缓存；关掉则每次重新问，更安全但更烦人）。 */
  readonly cacheDeny?: boolean | undefined;
  /** 需要做命令规范化再入键的工具名（默认 shell）。 */
  readonly commandTools?: readonly string[] | undefined;
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
  /**
   * 审批器标识：固定为 'cached'，用于在多审批后端中区分缓存装饰层。
   */
  public readonly name = 'cached';

  /** 裁决缓存表：缓存键 → 审批裁决（Map 插入序即 LRU 旧→新）。 */
  private readonly store = new Map<string, ApprovalDecision>();
  /** 缓存上限，超出淘汰最久未用条目。 */
  private readonly maxEntries: number;
  /** 是否缓存 deny 裁决（false 则 deny 每次重新询问，更安全）。 */
  private readonly cacheDeny: boolean;
  /** 需要做命令规范化再入键的工具名集合（默认仅 shell）。 */
  private readonly commandTools: ReadonlySet<string>;
  /** 缓存命中次数（可观测/测试用）。 */
  private hitCount = 0;
  /** 缓存未命中次数（可观测/测试用）。 */
  private missCount = 0;

  /**
   * @param inner 被装饰的内层审批端口（缓存未命中时才询问它）。
   * @param options 缓存选项（cwd/策略指纹/上限等，全有默认）。
   */
  public constructor(
    private readonly inner: ApprovalPort,
    private readonly options: CachedApprovalOptions = {},
  ) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.cacheDeny = options.cacheDeny ?? true;
    this.commandTools = new Set(options.commandTools ?? [TOOL_NAMES.shell]);
  }

  /** 被装饰的审批端口。 */
  public get delegate(): ApprovalPort {
    return this.inner;
  }

  /** 命中次数（可观测/测试用）。 */
  public get hits(): number {
    return this.hitCount;
  }

  /** 未命中次数（可观测/测试用）。 */
  public get misses(): number {
    return this.missCount;
  }

  /** 当前缓存条目数。 */
  public get size(): number {
    return this.store.size;
  }

  /** 裁决请求：命中直接返回，否则问内层后按策略写回。
   * @param request 审批请求（工具名、目标、理由等）。
   * @returns 缓存或内层端口给出的裁决（'allow'/'deny' 等）。
   */
  public async decide(request: ApprovalRequest): Promise<ApprovalDecision> {
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

  /** 清空缓存（策略变更、会话切换时调用）。
   * @returns 无返回值。
   */
  public invalidate(): void {
    this.store.clear();
  }

  /** 是否值得缓存：deny 可配置为不缓存。
   * @param decision 内层端口给出的裁决。
   * @returns 该裁决是否应写入缓存（allow 恒缓存，deny 取决于 cacheDeny）。
   */
  private shouldCache(decision: ApprovalDecision): boolean {
    return decision === 'allow' || this.cacheDeny;
  }

  /** 写入并按 LRU 淘汰。
   * @param key 缓存键。
   * @param decision 待缓存的裁决。
   * @returns 无返回值。
   */
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

  /** 命中后提到最新（保持 LRU 顺序）。
   * @param key 缓存键。
   * @param decision 该键对应的裁决（删除重插保持原值）。
   * @returns 无返回值。
   */
  private promote(key: string, decision: ApprovalDecision): void {
    this.store.delete(key);
    this.store.set(key, decision);
  }

  /** 构造缓存键：字段顺序固定，保证序列化稳定。
   * @param request 审批请求。
   * @returns 由工具名 + 规范化目标 + cwd + 策略指纹序列化成的缓存键。
   */
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
