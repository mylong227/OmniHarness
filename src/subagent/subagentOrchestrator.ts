import { ConcurrencyLimiter } from '../util/concurrencyLimiter.js';
import { id } from '../util/id.js';
import { SubagentRunner } from './subagentRunner.js';
import { createWorktree } from './worktree.js';
import type { SubagentPorts } from './subagentPorts.js';
import type { SubagentOptions, SubagentRequest, SubagentResult } from './subagentTypes.js';
import { DEFAULT_MAX_DEPTH, DEFAULT_SUBAGENT_MAX_STEPS } from './subagentTypes.js';

/** 默认并发上限（成熟产品量级，仍可被 config 覆盖）。 */
const DEFAULT_MAX_CONCURRENCY = 16;

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
  private readonly limiter: ConcurrencyLimiter;
  private readonly tree = new Map<string, string[]>();

  public constructor(
    private readonly ports: SubagentPorts,
    private readonly options: SubagentOptions = {},
  ) {
    this.limiter = new ConcurrencyLimiter(options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
  }

  /** 执行单个子任务（深度超限或执行异常均转为 ok:false 结果，不抛给调用方）。 */
  public async run(request: SubagentRequest): Promise<SubagentResult> {
    if (request.depth >= this.maxDepth()) {
      return this.failure(
        request,
        `子智能体派生深度已达上限 ${this.maxDepth()}（当前 depth=${request.depth}）`,
      );
    }
    return this.limiter.run(async () => {
      // 每个子智能体独立隔离文件系统（git worktree，失败降级为目录拷贝）。
      const worktree = await createWorktree(this.ports.workspaceRoot, id('wt'));
      try {
        const isolatedPorts: SubagentPorts = { ...this.ports, workspaceRoot: worktree.path };
        const result = await new SubagentRunner(isolatedPorts, this.maxSteps()).run(request);
        this.link(request.parentSessionId, result.sessionId);
        return result;
      } catch (error) {
        return this.failure(request, this.messageOf(error));
      } finally {
        // 无论成败都释放隔离资源，避免工作树/目录泄漏。
        await worktree.cleanup();
      }
    });
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

  /** 记录父子关系。 */
  private link(parentSessionId: string, childSessionId: string): void {
    const existing = this.tree.get(parentSessionId) ?? [];
    this.tree.set(parentSessionId, [...existing, childSessionId]);
  }

  /** 构造失败结果（保留深度与父子关系，便于定位）。 */
  private failure(request: SubagentRequest, error: string): SubagentResult {
    return {
      ok: false,
      sessionId: id('sess'),
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
