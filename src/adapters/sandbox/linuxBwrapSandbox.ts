import { execFileSync } from 'node:child_process';
import type { SandboxAction, SandboxDecision, SandboxPort } from '../../ports/sandbox.js';

/**
 * Linux bubblewrap (bwrap) OS 级沙箱后端（A1）。
 *
 * fail-closed 铁律：若探测不到 `bwrap` 二进制，check() 一律返回
 * `{allowed:false}`，绝不谎称已隔离、绝不静默放行。
 */
export class LinuxBwrapSandbox implements SandboxPort {
  /** 沙箱后端名称（标识此 bwrap 实现）。 */
  public readonly name = 'linux-bwrap';

  /**
   * @param workspace 受限写入的 workspace 根目录（bwrap 可写 bind 的子路径）。
   */
  public constructor(private readonly workspace: string) {}

  /** 探测 bwrap 是否可用（catch 全部异常，缺二进制即视为不可用）。
   * @returns `which bwrap` 成功时为 true。
   */
  private hasBwrap(): boolean {
    try {
      execFileSync('which', ['bwrap'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  /** 受限策略：默认拒绝网络；写仅限 workspace；命令执行走 bwrap 隔离。
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
          reason: `bwrap 策略：写操作仅限 workspace (${this.workspace})`,
          category: 'path',
        };
      case 'file_read':
        // 只读全局 ro-bind 可见，放行。
        return { allowed: true };
      case 'command':
        // 命令执行将被 bwrap 隔离（--unshare-net 禁网络）。
        return { allowed: true };
      default:
        return { allowed: false, reason: 'bwrap 未知动作', category: 'other' };
    }
  }

  /** 同步审批端口：返回受限决策（与 check 同策略，但非 Promise）。
   * @param action 待审批的沙箱动作。
   * @returns 沙箱决策（bwrap 不可用时 fail-closed 拒绝）。
   */
  public decide(action: SandboxAction): SandboxDecision {
    if (!this.hasBwrap()) {
      return {
        allowed: false,
        reason: 'bwrap 不可用，无法提供 Linux 隔离（fail-closed）',
        category: 'os',
      };
    }
    return this.restrictedDecision(action);
  }

  /**
   * 异步审批：bwrap 可用时返回受限决策，不可用时 fail-closed 拒绝。
   * @param action 待审批的沙箱动作
   * @returns 沙箱决策（允许/拒绝 + 理由 + 类别）
   */
  public async check(action: SandboxAction): Promise<SandboxDecision> {
    if (!this.hasBwrap()) {
      return {
        allowed: false,
        reason: 'bwrap 不可用，无法提供 Linux 隔离（fail-closed）',
        category: 'os',
      };
    }
    return this.restrictedDecision(action);
  }

  /**
   * 返回将要执行的完整 bwrap 命令行（供测试断言隔离意图）。
   * 策略：根只读 bind，workspace 可写，禁网络，随父进程退出。
   *
   * @param command 将要在沙箱内执行的命令。
   * @param args 命令参数。
   * @param workspace 工作区根目录（可写 bind 目标）。
   * @returns bwrap 完整命令行参数数组。
   */
  public dryRun(command: string, args: readonly string[], workspace: string): string[] {
    return [
      'bwrap',
      '--ro-bind',
      '/',
      '/',
      '--bind',
      workspace,
      workspace,
      '--unshare-net',
      '--die-with-parent',
      command,
      ...args,
    ];
  }
}
