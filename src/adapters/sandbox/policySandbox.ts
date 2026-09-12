import type { SandboxAction, SandboxDecision, SandboxPort } from '../../ports/sandbox.js';
import { dangerousCommands } from './dangerousCommands.js';
import { WorkspaceGuard } from '../../util/workspaceGuard.js';

/** 策略沙箱选项。 */
export interface PolicySandboxOptions {
  readonly workspaceRoot: string;
  readonly extraPatterns?: readonly RegExp[];
}

/** 策略沙箱适配器：危险命令黑名单 + 工作区路径白名单，命中即拒绝（fail-closed）。 */
export class PolicySandbox implements SandboxPort {
  /** 适配器名，与端口契约一致：固定为 'policy'。 */
  public readonly name = 'policy';

  private readonly guard: WorkspaceGuard;
  private readonly patterns: readonly RegExp[];

  public constructor(private readonly options: PolicySandboxOptions) {
    this.guard = new WorkspaceGuard(options.workspaceRoot);
    this.patterns = [...dangerousCommands.defaults(), ...(options.extraPatterns ?? [])];
  }

  /** 裁决动作。 */
  public async check(action: SandboxAction): Promise<SandboxDecision> {
    if (action.kind === 'command') {
      return this.checkCommand(action.target);
    }
    return this.checkPath(action.target);
  }

  /** 命令门禁：命中危险模式即拒绝。 */
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

  /** 路径门禁：工作区外即拒绝。 */
  private checkPath(target: string): SandboxDecision {
    if (this.guard.isInside(target)) {
      return { allowed: true };
    }
    return { allowed: false, reason: `路径越界: ${target}`, category: 'path' };
  }
}
