import { execFileSync } from 'node:child_process';
import type { SandboxAction, SandboxDecision, SandboxPort } from '../../ports/sandbox.js';

/**
 * macOS seatbelt (sandbox-exec) OS 级沙箱后端（A2）。
 *
 * fail-closed 铁律：非 macOS 平台或探测不到 `sandbox-exec`，
 * check() 一律返回 `{allowed:false}`，绝不谎称已隔离。
 */
export class MacOsSeatbeltSandbox implements SandboxPort {
  /** 沙箱后端标识名（SandboxPort 注册键，用于诊断）。 */
  public readonly name = 'macos-seatbelt';

  public constructor(private readonly workspace: string) {}

  /** 仅 macOS 平台且 sandbox-exec 可用才算可用。 */
  private hasSandboxExec(): boolean {
    if (process.platform !== 'darwin') return false;
    try {
      execFileSync('which', ['sandbox-exec'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  /** 生成 seatbelt profile 文本：禁网络出站，读写限 workspace。 */
  private buildProfile(workspace: string): string {
    return [
      '(version 1)',
      '(deny default)',
      '(allow process*)',
      '(allow file-read* (subpath "/"))',
      `(allow file-read* file-write* (subpath "${workspace}"))`,
      '(deny network-outbound)',
      '(allow network-outbound (local ip))',
    ].join('\n');
  }

  /** 受限策略：写仅限 workspace；禁网络出站；命令执行走 sandbox-exec。 */
  private restrictedDecision(action: SandboxAction): SandboxDecision {
    switch (action.kind) {
      case 'file_write':
        if (action.target.startsWith(this.workspace)) {
          return { allowed: true };
        }
        return {
          allowed: false,
          reason: `seatbelt 策略：写操作仅限 workspace (${this.workspace})`,
          category: 'path',
        };
      case 'file_read':
        return { allowed: true };
      case 'command':
        return { allowed: true };
      default:
        return { allowed: false, reason: 'seatbelt 未知动作', category: 'other' };
    }
  }

  /**
   * 同步决策单条动作的允许性：sandbox-exec 不可用则 fail-closed 拒绝；否则按受限策略裁定
   * （写仅限 workspace、读/命令放行、未知动作拒绝）。
   *
   * @param action 待裁决的沙箱动作
   * @returns 决策结果（allowed 及可选的 reason/category）
   */
  public decide(action: SandboxAction): SandboxDecision {
    if (!this.hasSandboxExec()) {
      return {
        allowed: false,
        reason: 'sandbox-exec 不可用（非 macOS 或缺失）',
        category: 'os',
      };
    }
    return this.restrictedDecision(action);
  }

  /**
   * 异步校验单条动作的允许性：语义与 {@link decide} 一致，sandbox-exec 不可用即 fail-closed 拒绝。
   *
   * @param action 待校验的沙箱动作
   * @returns 决策结果（allowed 及可选的 reason/category）
   */
  public async check(action: SandboxAction): Promise<SandboxDecision> {
    if (!this.hasSandboxExec()) {
      return {
        allowed: false,
        reason: 'sandbox-exec 不可用（非 macOS 或缺失）',
        category: 'os',
      };
    }
    return this.restrictedDecision(action);
  }

  /**
   * 返回将要执行的 sandbox-exec 命令行（含 .sb profile 路径，供测试断言）。
   * profilePath 为将要写入的 .sb 路径（dryRun 不实际写文件/执行）。
   */
  public dryRun(
    command: string,
    args: readonly string[],
    workspace: string,
    profilePath = `${workspace}/.seatbelt.sb`,
  ): string[] {
    return ['sandbox-exec', '-f', profilePath, command, ...args];
  }

  /** 暴露生成的 .sb profile 文本，便于测试断言隔离意图。 */
  public profileText(workspace: string): string {
    return this.buildProfile(workspace);
  }
}
