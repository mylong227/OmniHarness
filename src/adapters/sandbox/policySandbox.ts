import type { SandboxAction, SandboxDecision, SandboxPort } from '../../ports/runtime/sandbox.js';
import { dangerousCommands } from './dangerousCommands.js';
import { WorkspaceGuard } from '../../util/workspaceGuard.js';

/** 策略沙箱选项。 */
export interface PolicySandboxOptions {
  /** 工作区根目录（路径白名单基准，越界即拒绝）。 */
  readonly workspaceRoot: string;
  /** 额外危险命令模式（合并进默认黑名单）。 */
  readonly extraPatterns?: readonly RegExp[];
}

/** 策略沙箱适配器：危险命令黑名单 + 工作区路径白名单，命中即拒绝（fail-closed）。 */
export class PolicySandbox implements SandboxPort {
  /** 适配器名，与端口契约一致：固定为 'policy'。 */
  public readonly name = 'policy';

  /** 工作区路径守卫（白名单判定委托给它）。 */
  private readonly guard: WorkspaceGuard;
  /** 危险命令正则集（默认黑名单 + 用户扩展）。 */
  private readonly patterns: readonly RegExp[];

  /**
   * @param options 策略沙箱选项（工作区根目录与额外危险模式）。
   */
  public constructor(private readonly options: PolicySandboxOptions) {
    this.guard = new WorkspaceGuard(options.workspaceRoot);
    this.patterns = [...dangerousCommands.defaults(), ...(options.extraPatterns ?? [])];
  }

  /** 裁决动作。
   * @param action 待裁决的沙箱动作（命令或路径）。
   * @returns 决策结果：命令走黑名单、路径走白名单，命中即 fail-closed 拒绝。
   */
  public async check(action: SandboxAction): Promise<SandboxDecision> {
    if (action.kind === 'command') {
      return this.checkCommand(action.target);
    }
    return this.checkPath(action.target);
  }

  /** 命令门禁：命中危险模式即拒绝。
   * @param command 待检查的命令串。
   * @returns 决策结果（命中时附规则来源与 'command' 类别）。
   */
  private checkCommand(command: string): SandboxDecision {
    for (const pattern of this.patterns) {
      if (pattern.test(command)) {
        return {
          allowed: false,
          reason: `命中危险命令规则: ${pattern.source}`,
          category: 'command',
        };
      }
    }
    return { allowed: true };
  }

  /** 路径门禁：工作区外即拒绝。
   * @param target 待检查的路径。
   * @returns 决策结果（越界时附 'path' 类别）。
   */
  private checkPath(target: string): SandboxDecision {
    if (this.guard.isInside(target)) {
      return { allowed: true };
    }
    return { allowed: false, reason: `路径越界: ${target}`, category: 'path' };
  }
}
