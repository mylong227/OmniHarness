import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { SandboxPort } from '../../ports/runtime/sandbox.ts';
import type { SandboxAction } from '../../ports/runtime/sandbox/sandboxAction.ts';
import type { SandboxDecision } from '../../ports/runtime/sandbox/sandboxDecision.ts';
import type { AclSandboxOptions } from '@deepseek-ai/dsh-sandbox-windows-acl';

/** 可选依赖公开选项的再导出（仅类型层；运行期由 `runner` 子路径解析，不在导入时加载 koffi）。 */
export type WindowsAclOptions = AclSandboxOptions;

/**
 * Windows ACL 写限制沙箱（2026-10-21）。
 *
 * 依赖 `@deepseek-ai/dsh-sandbox-windows-acl`（可选依赖）：它把一个 `WRITE_RESTRICTED`
 * 受限令牌 + 按工作区派生的写入 SID 物化到工作区 DACL 上，再由 runner 以该令牌启动命令。
 * 这是**真实 OS 级写隔离**（不是策略/正则）：受限进程只能写工作区与会话临时目录，系统其余位置
 * 的写入被令牌交集拒绝。
 *
 * 已知边界（包自身文档，必须如实转述）：只限制**写**；读、网络、进程可见性不受限；子进程共享
 * 宿主控制台；工作区 ACE 常驻（跨会话复用缓存）。需要读隔离/网络隔离时仍应配合策略或更强后端。
 */
export class WindowsAclSandbox implements SandboxPort {
  /** 后端名（与 profile 一致，doctor 能力表据此展示）。 */
  public readonly name: string;

  /**
   * @param workspaceRoot 工作区根（唯一可写目录）。
   * @param mode 写模式：workspace-write（工作区可写）或 read-only（零写入授权）。
   */
  public constructor(
    private readonly workspaceRoot: string,
    private readonly mode: 'workspace-write' | 'read-only' = 'workspace-write',
  ) {
    this.name = mode === 'read-only' ? 'windows-acl-readonly' : 'windows-acl';
  }

  /**
   * 该后端不改变策略裁决：命令/文件访问仍由 ToolGate 按原始动作裁决，这里只负责执行隔离。
   * @param _action 待裁决动作。
   * @returns 恒允许（隔离在 wrapCommand 的 OS 令牌层生效）。
   */
  public async check(_action: SandboxAction): Promise<SandboxDecision> {
    return { allowed: true };
  }

  /**
   * 把命令包装成「runner + 受限令牌」调用。
   *
   * 命令写入工作区私有的 `.omniharness/sandbox/cmd-<hash>.cmd`，再由 `cmd.exe /c <file>`
   * 执行——避免把任意命令文本直接拼进多层 cmd 引号（注入/双重解析面）。
   * @param command 原始 shell 命令文本。
   * @param cwd 命令工作目录。
   * @returns 可交给 ShellProcessRunner 执行的包装命令。
   * @throws 可选依赖未安装、非 Windows、或工作区不可写时抛出（fail-closed）。
   */
  public wrapCommand(command: string, cwd: string): string {
    if (process.platform !== 'win32') {
      throw new Error('windows-acl 仅支持 Windows；非 Windows 请使用 bwrap/seatbelt/unshare');
    }
    const runner = WindowsAclSandbox.runnerPath();
    const sandboxDir = join(this.workspaceRoot, '.omniharness', 'sandbox');
    mkdirSync(sandboxDir, { recursive: true, mode: 0o700 });
    const hash = createHash('sha256').update(`${cwd}\0${command}`).digest('hex').slice(0, 16);
    const script = join(sandboxDir, `cmd-${hash}.cmd`);
    writeFileSync(script, `@echo off\r\n${command}\r\n`, { encoding: 'utf8', mode: 0o600 });
    const cmd = process.env['ComSpec'] ?? 'cmd.exe';
    return [
      `"${process.execPath}"`,
      WindowsAclSandbox.quote(runner),
      '--workspace',
      WindowsAclSandbox.quote(this.workspaceRoot),
      '--temp',
      WindowsAclSandbox.quote(sandboxDir),
      '--mode',
      this.mode,
      '--',
      WindowsAclSandbox.quote(cmd),
      '/d',
      '/s',
      '/c',
      WindowsAclSandbox.quote(script),
    ].join(' ');
  }

  /**
   * 解析可选依赖的 runner 入口。
   * @returns runner 的绝对路径。
   * @throws 依赖未安装时抛出可行动的安装提示。
   */
  private static runnerPath(): string {
    try {
      return createRequire(import.meta.url).resolve('@deepseek-ai/dsh-sandbox-windows-acl/runner');
    } catch {
      throw new Error(
        'windows-acl 需要可选依赖 @deepseek-ai/dsh-sandbox-windows-acl；' +
          '请运行 `npm install @deepseek-ai/dsh-sandbox-windows-acl`（或重新 npm install 可选依赖）',
      );
    }
  }

  /**
   * Windows 命令行参数加引号（路径/程序名可能含空格）。
   * @param value 原始参数。
   * @returns 双引号包裹的参数（内部不可能出现 `"` 的路径场景）。
   */
  private static quote(value: string): string {
    return `"${value.replace(/"/g, '""')}"`;
  }
}
