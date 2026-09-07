import { execFileSync } from 'node:child_process';
import type { SandboxAction, SandboxDecision, SandboxPort } from '../../ports/sandbox.js';

/**
 * macOS seatbelt (sandbox-exec) OS 级沙箱后端（A2）。
 *
 * fail-closed 铁律：非 macOS 平台或探测不到 `sandbox-exec`，
 * check() 一律返回 `{allowed:false}`，绝不谎称已隔离。
 */
export class MacOsSeatbeltSandbox implements SandboxPort {
  readonly name = 'macos-seatbelt';

  constructor(private readonly workspace: string) {}

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

  decide(action: SandboxAction): SandboxDecision {
    if (!this.hasSandboxExec()) {
      return {
        allowed: false,
        reason: 'sandbox-exec 不可用（非 macOS 或缺失）',
        category: 'os',
      };
    }
    return this.restrictedDecision(action);
  }

  async check(action: SandboxAction): Promise<SandboxDecision> {
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
  dryRun(
    command: string,
    args: readonly string[],
    workspace: string,
    profilePath = `${workspace}/.seatbelt.sb`,
  ): string[] {
    return ['sandbox-exec', '-f', profilePath, command, ...args];
  }

  /** 暴露生成的 .sb profile 文本，便于测试断言隔离意图。 */
  profileText(workspace: string): string {
    return this.buildProfile(workspace);
  }
}
