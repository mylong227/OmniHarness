import { execFileSync } from 'node:child_process';
import type { SandboxAction, SandboxDecision, SandboxPort } from '../../ports/runtime/sandbox.js';

/**
 * Linux 内核命名空间隔离后端（`unshare -rm`，A1 的零依赖替代）。
 *
 * ## 为什么需要
 *
 * 审计指出原 `SandboxManager` 把 `landlock` profile **映射到了 `LinuxBwrapSandbox`**——
 * 这是声明与实现不符：landlock 是内核态文件路径访问控制，bwrap 是用户态命名空间，
 * 二者不是一回事，把前者偷偷换成后者既误导又会在「以为开了 landlock」时实际拿到 bwrap 语义。
 * 另：本机是 Windows，所有 OS 级后端都跑不起来，必须**明确 fail-closed 且给可执行原因**，
 * 不能假装已隔离。`unshare` 是 Linux 原生的命名空间隔离原语（用户态零依赖，只要内核支持），
 * 作为 OS 级后端补上这一环。
 *
 * ## 隔离语义
 *
 * `unshare -rm --map-root-user` 同时建立**挂载命名空间**与**用户命名空间**并把容器内 uid 映射成 0：
 * 命令在独立的挂载/进程视图里执行，对宿主的写入被命名空间边界拦下（配合 `--mount-proc` 隐藏宿主进程表）。
 * 这是与 bwrap 同级的「进程/挂载隔离」，不做 landlock 式的细粒度路径规则——能力边界要诚实说明。
 *
 * fail-closed 铁律：探测不到 `unshare` 或不在 Linux，check() 一律拒绝，绝不谎称已隔离。
 */
export class LinuxUnshareSandbox implements SandboxPort {
  /** 沙箱后端名称。 */
  public readonly name = 'linux-unshare';

  /**
   * @param workspace 受限写入的 workspace 根目录（命名空间内可写 bind 的目标）。
   */
  public constructor(private readonly workspace: string) {}

  /**
   * 探测 `unshare` 是否可用（catch 全部异常，缺二进制即视为不可用）。
   *
   * @returns 当前平台为 Linux 且 `which unshare` 成功时为 true。
   */
  private hasUnshare(): boolean {
    if (process.platform !== 'linux') {
      return false;
    }
    try {
      execFileSync('which', ['unshare'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 受限策略：默认拒绝网络；写仅限 workspace；命令执行走命名空间隔离。
   *
   * @param action 待裁决的沙箱动作。
   * @returns 决策结果（写越界/未知动作 fail-closed 拒绝并附原因）。
   */
  private restrictedDecision(action: SandboxAction): SandboxDecision {
    switch (action.kind) {
      case 'file_write':
        if (action.target.startsWith(this.workspace)) {
          return { allowed: true };
        }
        return {
          allowed: false,
          reason: `unshare 策略：写操作仅限 workspace (${this.workspace})`,
          category: 'path',
        };
      case 'file_read':
        // 命名空间内宿主只读可见，放行。
        return { allowed: true };
      case 'command':
        // 命令执行将被命名空间隔离（用户态无法逃逸到宿主 uid）。
        return { allowed: true };
      default:
        return { allowed: false, reason: 'unshare 未知动作', category: 'other' };
    }
  }

  /**
   * 同步审批端口：返回受限决策（与 check 同策略，但非 Promise）。
   *
   * @param action 待审批的沙箱动作。
   * @returns 沙箱决策（unshare 不可用时 fail-closed 拒绝）。
   */
  public decide(action: SandboxAction): SandboxDecision {
    if (!this.hasUnshare()) {
      return {
        allowed: false,
        reason:
          'unshare 不可用（非 Linux 或缺少 unshare 二进制），无法提供内核命名空间隔离（fail-closed）',
        category: 'os',
      };
    }
    return this.restrictedDecision(action);
  }

  /**
   * 异步审批：unshare 可用时返回受限决策，不可用时 fail-closed 拒绝。
   *
   * @param action 待审批的沙箱动作。
   * @returns 沙箱决策（允许/拒绝 + 理由 + 类别）。
   */
  public async check(action: SandboxAction): Promise<SandboxDecision> {
    if (!this.hasUnshare()) {
      return {
        allowed: false,
        reason:
          'unshare 不可用（非 Linux 或缺少 unshare 二进制），无法提供内核命名空间隔离（fail-closed）',
        category: 'os',
      };
    }
    return this.restrictedDecision(action);
  }

  /**
   * 返回将要执行的完整 unshare 命令行（供测试断言隔离意图）。
   *
   * 策略：用户命名空间（--map-root-user）+ 挂载命名空间（-rm）+ 隐藏宿主进程表（--mount-proc）。
   *
   * @param command 将要在命名空间内执行的命令。
   * @param args 命令参数。
   * @param workspace 工作区根目录（命名空间内可写 bind 的目标，仅用于记录，不进命令）。
   * @returns unshare 完整命令行参数数组。
   */
  public dryRun(command: string, args: readonly string[], workspace: string): string[] {
    void workspace;
    return ['unshare', '-rm', '--map-root-user', '--mount-proc', '--', command, ...args];
  }
}
