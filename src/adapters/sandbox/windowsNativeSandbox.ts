import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SandboxAction, SandboxDecision, SandboxPort } from '../../ports/runtime/sandbox.ts';
import { OmniCliLocator } from '../../native/omniCliLocator.ts';
import { RestrictedSandbox } from './restrictedSandbox.ts';

/**
 * Windows 原生写隔离沙箱（TS 侧适配器）。
 *
 * 裁决面复用 {@link RestrictedSandbox}（危险命令 / 路径 / 外联规则不变）；执行面把命令
 * 交给 `omni-cli sandbox run --workspace <root>`——Rust 侧用 `WRITE_RESTRICTED` 令牌 +
 * 工作区写入 SID 真正限制写边界。命令文本落成工作区内的临时文件，再以
 * `--command-file` 传入，避免多层 cmd 引号把命令解析坏。
 *
 * 边界如实：只限制写；读、网络、进程可见性不受限（需要读/网络隔离请选 wsl-bwrap/container）。
 */
export class WindowsNativeSandbox implements SandboxPort {
  /** 端口名（与 profile 一致）。 */
  public readonly name = 'windows-native';

  /** 裁决器：策略面与 restricted 完全同源。 */
  private readonly policy: RestrictedSandbox;

  /**
   * @param workspaceRoot 工作区根（唯一可写目录）。
   */
  public constructor(private readonly workspaceRoot: string) {
    this.policy = new RestrictedSandbox({ workspaceRoot });
  }

  /**
   * 策略裁决（与 restricted 同口径）。
   * @param action 待裁决动作。
   * @returns 允许 / 拒绝。
   */
  public async check(action: SandboxAction): Promise<SandboxDecision> {
    return this.policy.check(action);
  }

  /**
   * 把命令包装成原生写隔离启动器调用。
   * @param command 原始命令文本。
   * @param cwd 命令工作目录（保留签名；实际由外层执行器设为工作区）。
   * @returns 可交给 shell 执行器的包装命令。
   * @throws 非 Windows 或找不到 omni-cli 时抛出（fail-closed）。
   */
  public wrapCommand(command: string, cwd: string): string {
    if (process.platform !== 'win32') {
      throw new Error('windows-native 仅支持 Windows；其它平台请用 bwrap/seatbelt/unshare');
    }
    const binary = OmniCliLocator.locate();
    const sandboxDir = join(this.workspaceRoot, '.omniharness', 'sandbox');
    mkdirSync(sandboxDir, { recursive: true, mode: 0o700 });
    const hash = createHash('sha256').update(`${cwd}\0${command}`).digest('hex').slice(0, 16);
    const script = join(sandboxDir, `cmd-${hash}.txt`);
    writeFileSync(script, command, { encoding: 'utf8', mode: 0o600 });
    return [
      WindowsNativeSandbox.quote(binary),
      'sandbox',
      'run',
      '--workspace',
      WindowsNativeSandbox.quote(this.workspaceRoot),
      '--command-file',
      WindowsNativeSandbox.quote(script),
    ].join(' ');
  }

  /**
   * Windows 命令行参数加引号（内部引号用双写转义，供 cmd 解析）。
   * @param value 原始参数。
   * @returns 双引号包裹的参数。
   */
  private static quote(value: string): string {
    return `"${value.replace(/"/gu, '""')}"`;
  }
}
