import { ConcurrencyLimiter } from '../util/concurrency/concurrencyLimiter.js';
import { SubagentToolScope } from './subagentToolScope.js';
import { log } from '../util/logger.js';
import { Id } from '../util/id.js';
import { SubagentRunner } from './subagentRunner.js';
import { WorktreeOps, type Worktree } from './worktreeOps.js';
import type { SubagentPortsShape } from './subagentPorts.js';
import type { SubagentOptions, SubagentRequest, SubagentResult } from './subagentTypes.js';
import {
  CANCELLED_BY_PARENT_MESSAGE,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_MAX_DEPTH,
  DEFAULT_SUBAGENT_MAX_STEPS,
} from './subagentTypes.js';

/**
 * @beta
 * 子智能体编排器：深度限制 + 并发限流 + 父子关系记录。
 *
 * 三道约束缺一不可：
 * - 深度限制：杜绝无限套娃（与工具视图剔除 subagent 形成双重保险）；
 * - 并发限流：所有子代共享进程内资源（模型/存储/FFI 内核），无闸门会被长任务拖垮；
 * - 父子树：失败与耗时可追溯到具体子会话，否则子智能体是黑盒。
 */
export class SubagentOrchestrator {
  /** 父子关系表上限：跨长时运行进程可能累积海量会话，超出后淘汰最旧条目避免无界增长。 */
  private static readonly MAX_TREE_ENTRIES = 4096;
  private readonly limiter: ConcurrencyLimiter;
  private readonly tree = new Map<string, string[]>();

  public constructor(
    private readonly ports: SubagentPortsShape,
    private readonly options: SubagentOptions = {},
  ) {
    // 非法并发上限 fail-closed（`--subagent-concurrency 0` 会让闸门永不放行 ⇒ 每个子代理永久挂起）。
    this.limiter = new ConcurrencyLimiter(
      ConcurrencyLimiter.requireConcurrencyLimit(
        options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
        'subagentConcurrency',
      ),
    );
  }

  /** 执行单个子任务（深度超限 / 父已取消 / 执行异常均转为 ok:false 结果，不抛给调用方）。 */
  public async run(request: SubagentRequest): Promise<SubagentResult> {
    if (request.depth >= this.maxDepth()) {
      return this.failure(
        request,
        `子智能体派生深度已达上限 ${this.maxDepth()}（当前 depth=${request.depth}）`,
      );
    }
    // 父会话已取消：连并发槽位都不必等，直接 fail-closed（不建隔离工作树、不进模型调用）。
    if (this.cancelled(request)) {
      return this.failure(request, CANCELLED_BY_PARENT_MESSAGE);
    }
    return this.limiter.run(async () => {
      // 排队期间父可能已取消：拿到槽位后再判一次，避免「等到槽位才发现该收工」。
      if (this.cancelled(request)) {
        return this.failure(request, CANCELLED_BY_PARENT_MESSAGE);
      }
      // 每个子智能体独立隔离文件系统（git worktree，失败降级为目录拷贝）。
      // 取消信号透传：worktree 创建原先是「无超时 + 无取消 + 卡在并发闸门内」的组合，
      // 一个挂住的创建会把整个回合永久黑洞（2026-10-01 审计）。
      const worktree = await WorktreeOps.createWorktree(
        this.ports.workspaceRoot,
        Id.id('wt'),
        request.signal,
      );
      let result: SubagentResult;
      try {
        const isolatedPorts: SubagentPortsShape = { ...this.ports, workspaceRoot: worktree.path };
        // copy 模式（git 不可用/失败）：改动**无法**采集为 patch（没有 git 可比），
        // 故按 fail-closed 直接**禁止写类工具**——宁可让子代理明确说"我改不了代码"，
        // 也不要让它改完之后改动静默消失（看板 §8.1）。
        const effective =
          worktree.isolated === 'copy'
            ? SubagentToolScope.writeForbidden(
                request,
                this.ports.tools.list().map((definition) => definition.name),
              )
            : request;
        result = await new SubagentRunner(isolatedPorts, this.maxSteps()).run(effective);
        this.link(request.parentSessionId, result.sessionId);
        if (worktree.isolated === 'copy') {
          result = { ...result, writesForbidden: true };
        }
      } catch (error) {
        result = this.failure(request, this.messageOf(error));
      }
      // 清理**之前**把改动取出来（看板 §8.1）：`cleanup()` 是 `worktree remove --force` + `branch -D`，
      // 不先采集就是静默丢弃。采集失败也必须**显式标记**（`writesUnrecoverable`），绝不静默。
      const withWrites = await this.attachWrites(worktree, result);
      // 无论成败（含父取消导致的失败）都释放隔离资源，避免工作树/目录泄漏。
      await worktree.cleanup();
      return withWrites;
    });
  }

  /**
   * 采集隔离工作树里的改动并挂到结果上（清理前的最后一步）。
   *
   * 为什么要有它：子代理的写入原先随工作树一起被删掉——父代理收到 `ok:true` 却拿不到任何改动，
   * 这是"假成功 + 静默数据丢失"。现在把 patch 落到 `.omniharness/subagent-patches/`（gitignored）
   * 并把文件清单/路径回传，父级或用户可 `git apply` 取回。
   *
   * 全部 fail-soft + fail-closed 标记：采集/落盘异常只告警并把 `writesUnrecoverable` 置真
   * （子任务本身不该因为"取不回改动"而失败，但**必须**让父级知道改动丢了）。
   *
   * copy 模式**不做采集**：该模式下写类工具已被 {@link SubagentToolScope.writeForbidden} 禁止，且没有 git 可比，
   * 若仍去采集会因 `git` 报错而把"本就没改动"误报成"改动丢了"（假警报会稀释真警报）。
   * @param worktree 隔离工作树。
   * @param result 子代理结果。
   * @returns 挂了改动信息的结果（无改动时原样返回）。
   */
  private async attachWrites(worktree: Worktree, result: SubagentResult): Promise<SubagentResult> {
    if (worktree.isolated === 'copy') {
      return result;
    }
    try {
      const changes = await WorktreeOps.collectChanges(worktree.path);
      if (changes.files.length === 0) {
        return result;
      }
      const artifact = await WorktreeOps.persistChanges(
        this.ports.workspaceRoot,
        result.sessionId,
        changes,
      );
      log.warn('subagent.writes.isolated', {
        sessionId: result.sessionId,
        files: changes.files.length,
        patchPath: artifact.relativePath,
        hint: '子代理写入落在隔离工作树，主工作区未改动；如需采纳请 git apply 该 patch',
      });
      return {
        ...result,
        changedFiles: changes.files,
        patchPath: artifact.relativePath,
        patchBytes: artifact.bytes,
        ...(changes.truncated ? { patchTruncated: true } : {}),
      };
    } catch (error) {
      log.warn('subagent.writes.captureFailed', {
        sessionId: result.sessionId,
        error: this.messageOf(error),
        hint: '改动确实存在但取不回来；已把 writesUnrecoverable 置真，绝不静默',
      });
      return { ...result, writesUnrecoverable: true };
    }
  }

  /**
   * 父会话是否已取消（未注入取消信号时恒为 false）。
   * @param request 子任务请求（其 signal 来自父会话取消令牌）
   * @returns 已取消为 true
   */
  private cancelled(request: SubagentRequest): boolean {
    return request.signal?.aborted === true;
  }

  /** 批量并发执行（受同一并发闸门约束，先到先服务）。 */
  public async runAll(requests: readonly SubagentRequest[]): Promise<readonly SubagentResult[]> {
    return Promise.all(requests.map((request) => this.run(request)));
  }

  /** 某会话直接派生的子会话 ID（父子树，观测/审计用）。 */
  public childrenOf(parentSessionId: string): readonly string[] {
    return this.tree.get(parentSessionId) ?? [];
  }

  /** 当前并发上限。 */
  public maxConcurrency(): number {
    return this.limiter.limitOf();
  }

  /** 当前最大派生深度。 */
  public maxDepth(): number {
    return this.options.maxDepth ?? DEFAULT_MAX_DEPTH;
  }

  /** 单个子智能体的步数上限。 */
  public maxSteps(): number {
    return this.options.maxSteps ?? DEFAULT_SUBAGENT_MAX_STEPS;
  }

  /** 记录父子关系（超出上限淘汰最旧条目，避免跨长时进程无界增长）。
   * @returns 无返回值。
   */
  private link(parentSessionId: string, childSessionId: string): void {
    const existing = this.tree.get(parentSessionId) ?? [];
    this.tree.set(parentSessionId, [...existing, childSessionId]);
    if (this.tree.size > SubagentOrchestrator.MAX_TREE_ENTRIES) {
      const oldest = this.tree.keys().next().value;
      if (oldest !== undefined) {
        this.tree.delete(oldest);
      }
    }
  }

  /** 构造失败结果（保留深度与父子关系，便于定位）。 */
  private failure(request: SubagentRequest, error: string): SubagentResult {
    return {
      ok: false,
      sessionId: Id.id('sess'),
      output: '',
      steps: 0,
      durationMs: 0,
      depth: request.depth,
      events: [],
      error,
    };
  }

  /** 提取错误消息。 */
  private messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
