/**
 * 工具级资源域闸（2026-10-28，BLOCKERS §5 收口：给工具声明资源域与锁语义）。
 *
 * ## 解决的真实争抢
 *
 * `BrowserSession` **跨调用复用同一个浏览器**（跨调用冷启太贵）——两个会话并发调
 * `browser_act` / `browser_screenshot` 时共享同一张标签页：A 会话 `navigate(X)` 与
 * B 会话 `screenshot(Y)` 交错执行，B 截到的是 A 的页面。技能激活层的 `exclusive`
 * 互斥只管「同会话同回合的技能规划」，跨**会话**的工具级争抢此前无人管。
 *
 * ## 语义
 *
 * 1. **声明**：工具 → 资源域绑定收在 `ports/tool/toolResourceDomains.ts`（单一来源）；
 * 2. **互斥**：同域写锁跨会话串行（`KeyedReadWriteLock`：读读并行/写写互斥/FIFO/写优先）；
 * 3. **接入点**：门禁**之后**、pre 钩子**之前**——等审批（可能几分钟）绝不持锁；
 * 4. **取消**：等待期响应会话 AbortSignal（LockError('aborted')），锁不泄漏；
 * 5. **开关**：`OMNI_TOOL_DOMAIN_LOCKS=0` 关闭（返回空释放函数，零行为变更）。
 *
 * 进程级单例由组合根持有（`ResolvedConfig.toolResourceGate`），全会话共享同一张锁表。
 */
import { KeyedReadWriteLock, type LockRelease } from '../util/concurrency/keyedReadWriteLock.ts';
import {
  TOOL_RESOURCE_DOMAINS,
  type ToolResourceDomainBinding,
} from '../ports/tool/toolResourceDomains.ts';
import type { ToolResourceGatePort } from '../ports/runtime/toolResourceGatePort.ts';

/** 空释放函数（闸关闭/无可声明域时返回）。 */
const noopRelease: LockRelease = (): void => {};

/** 工具级资源域闸实现。 */
export class ToolResourceGate implements ToolResourceGatePort {
  /** 适配器标识：用于端口注册与诊断日志归组（固定值 'tool-resource-gate'）。 */
  public readonly name = 'tool-resource-gate';
  /** 键控读写锁（进程内互斥；跨进程文件锁不在本层——浏览器等宿主资源本就进程独占）。 */
  private readonly lock = new KeyedReadWriteLock();
  /** 闸开关（构造期读 env 一次）。 */
  private readonly enabled: boolean;

  /**
   * 取工具的资源域绑定（未登记返回空数组；ports 只存纯数据，查询口在消费方）。
   * @param toolName 工具名。
   * @returns 域绑定列表（可能为空）。
   */
  private static domainsOf(toolName: string): readonly ToolResourceDomainBinding[] {
    return TOOL_RESOURCE_DOMAINS[toolName] ?? [];
  }

  /**
   * @param env 环境变量源（测试注入；缺省 process.env）。
   */
  public constructor(env: NodeJS.ProcessEnv = process.env) {
    this.enabled = env['OMNI_TOOL_DOMAIN_LOCKS'] !== '0';
  }

  /**
   * 按声明域获取锁（多域按字典序，防 ABBA 死锁；同调用重复域去重）。
   * @param toolName 工具名。
   * @param sessionId 发起会话。
   * @param signal 取消信号。
   * @returns 幂等释放函数。
   * @throws LockError 等待被取消。
   */
  public async acquire(
    toolName: string,
    sessionId: string,
    signal?: AbortSignal | undefined,
  ): Promise<LockRelease> {
    if (!this.enabled) {
      return noopRelease;
    }
    const domains = ToolResourceGate.domainsOf(toolName);
    if (domains.length === 0) {
      return noopRelease;
    }
    // 字典序去重获取：跨域嵌套调用（未来出现的多域工具）不会因获取序不一致而死锁。
    const ordered = [...domains].sort((a, b) =>
      a.domain === b.domain ? a.mode.localeCompare(b.mode) : a.domain < b.domain ? -1 : 1,
    );
    const releases: LockRelease[] = [];
    try {
      for (const binding of ordered) {
        releases.push(await this.acquireOne(binding, sessionId, signal));
      }
    } catch (error) {
      // 部分获取失败：释放已拿到的（幂等），再把取消上抛。
      for (const release of releases.reverse()) release();
      throw error;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const release of releases.reverse()) release();
    };
  }

  /**
   * 获取单域锁（锁键 = 域名 + 会话隔离仅用于观测；互斥是**跨会话**的）。
   * @param binding 域绑定。
   * @param _sessionId 发起会话（观测用）。
   * @param signal 取消信号。
   * @returns 释放函数。
   * @throws LockError 等待被取消。
   */
  private async acquireOne(
    binding: ToolResourceDomainBinding,
    _sessionId: string,
    signal?: AbortSignal | undefined,
  ): Promise<LockRelease> {
    return binding.mode === 'read'
      ? await this.lock.acquireRead(binding.domain, { signal })
      : await this.lock.acquireWrite(binding.domain, { signal });
  }

  /**
   * 观测快照（诊断用）。
   * @returns 锁表计数与峰值。
   */
  public stats(): {
    readonly keys: number;
    readonly readers: number;
    readonly writers: number;
    readonly waiters: number;
  } {
    return this.lock.stats();
  }
}
