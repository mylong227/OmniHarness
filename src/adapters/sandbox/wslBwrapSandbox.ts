import { execFileSync } from 'node:child_process';
import type { SandboxAction, SandboxDecision, SandboxPort } from '../../ports/runtime/sandbox.ts';
import { WorkspaceGuard } from '../../util/workspaceGuard.ts';

/**
 * Windows 上的 L3 路径：WSL2 内的 bubblewrap（SEC-01，2026-10-20）。
 *
 * 为什么是 WSL2 而不是自研 AppContainer：AppContainer 需要原生 helper + 宿主 DACL 编排，
 * 本仓没有可复核的跨机器路径；WSL2 的 utility VM 是 Windows 上**现成**的内核边界，
 * 只要发行版里安装了 bwrap，就能得到「文件只读根 + workspace 可写 + 禁网」的隔离。
 *
 * 诚实边界：WSL2 不可达 / 发行版没有 bwrap 时一律 fail-closed 拒绝，绝不回退到 policy 档
 * 冒充隔离；`/mnt/c` 的自动挂载是否关闭由用户的 `.wslconfig` 决定，本类只能保证命令在
 * WSL 内被 bwrap 包装（`--unshare-net` 禁网）。
 */
export class WslBwrapSandbox implements SandboxPort {
  /** 适配器名。 */
  public readonly name = 'wsl-bwrap';

  /** 工作区路径守卫（写操作越界拒绝）。 */
  private readonly guard: WorkspaceGuard;

  /**
   * @param workspace Windows 工作区根（会被翻译成 `/mnt/<drive>/...`）。
   */
  public constructor(private readonly workspace: string) {
    this.guard = new WorkspaceGuard(workspace);
  }

  /**
   * 探测 WSL + bwrap 是否可用。
   * @returns 可用时为 true。
   */
  public available(): boolean {
    try {
      execFileSync('wsl.exe', ['-e', 'which', 'bwrap'], {
        stdio: 'ignore',
        timeout: 5_000,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 检查动作是否允许（WSL/bwrap 不可用即 fail-closed）。
   * @param action 沙箱动作。
   * @returns 决策。
   */
  public async check(action: SandboxAction): Promise<SandboxDecision> {
    if (!this.available()) {
      return {
        allowed: false,
        reason: 'WSL2/bwrap 不可用（fail-closed；不会回退到 policy 档冒充隔离）',
        category: 'os',
      };
    }
    if (action.kind === 'file_write') {
      return this.guard.isInside(action.target)
        ? { allowed: true }
        : { allowed: false, reason: 'WSL 沙箱：写操作仅限 workspace', category: 'path' };
    }
    if (action.kind === 'file_read') {
      return { allowed: true };
    }
    if (action.kind === 'command') {
      return { allowed: true };
    }
    return { allowed: false, reason: 'WSL 沙箱未知动作', category: 'other' };
  }

  /**
   * 把 shell 命令包进 WSL 的 bwrap。
   * @param command 原始命令。
   * @param _cwd 工作区根（本类用构造期 workspace；参数保留端口形态）。
   * @returns `wsl.exe -e bwrap ... /bin/sh -c "..."` 命令串。
   */
  public wrapCommand(command: string, _cwd: string): string {
    const linuxWorkspace = WslBwrapSandbox.toLinuxPath(this.workspace);
    const escaped = command.replace(/(["\\$`])/g, '\\$1');
    return [
      'wsl.exe',
      '-e',
      'bwrap',
      '--ro-bind',
      '/',
      '/',
      '--bind',
      linuxWorkspace,
      linuxWorkspace,
      '--unshare-net',
      '--die-with-parent',
      '/bin/sh',
      '-c',
      `"${escaped}"`,
    ].join(' ');
  }

  /**
   * Windows 路径 → WSL 路径（`D:\work\a` → `/mnt/d/work/a`）。
   * @param path Windows 或已经是 POSIX 的路径。
   * @returns WSL 内可用的路径。
   */
  public static toLinuxPath(path: string): string {
    const drive = /^([A-Za-z]):[\\/](.*)$/u.exec(path);
    if (drive !== null) {
      return `/mnt/${drive[1]!.toLowerCase()}/${drive[2]!.replace(/\\/g, '/')}`;
    }
    return path.replace(/\\/g, '/');
  }
}
