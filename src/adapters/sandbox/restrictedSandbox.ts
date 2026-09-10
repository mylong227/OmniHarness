import type { SandboxAction, SandboxDecision, SandboxPort } from '../../ports/sandbox.js';
import { DangerousCommands } from './dangerousCommands.js';
import { WorkspaceGuard } from '../../util/workspaceGuard.js';

/** 受限沙箱选项（G4：restricted profile = 强化策略后端）。 */
export interface RestrictedSandboxOptions {
  /** 工作区根目录（路径白名单基准）。 */
  readonly workspaceRoot: string;
  /** 额外危险模式（合并进默认危险命令集）。 */
  readonly extraPatterns?: readonly RegExp[];
}

/** 受限 profile 额外规则：网络外联 + 提权命令（比 policy 更严）。 */
const EXTRA_RESTRICTED: readonly RegExp[] = [
  /\bcurl\b/i,
  /\bwget\b/i,
  /\bnc\b|\bncat\b/i,
  /\bssh\b/i,
  /\bscp\b/i,
  /\bsudo\b/i,
  /\bchmod\s+777\b/i,
  /:\s*\(\s*\)\s*\{/i, // fork bomb
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
];

/** 受限沙箱适配器：policy 全部规则 + 网络外联/提权命令黑名单，命中即拒绝（fail-closed）。 */
export class RestrictedSandbox implements SandboxPort {
  public readonly name = 'restricted';

  private readonly guard: WorkspaceGuard;
  private readonly patterns: readonly RegExp[];

  public constructor(private readonly options: RestrictedSandboxOptions) {
    this.guard = new WorkspaceGuard(options.workspaceRoot);
    this.patterns = [
      ...DangerousCommands.defaults(),
      ...EXTRA_RESTRICTED,
      ...(options.extraPatterns ?? []),
    ];
  }

  /** 裁决动作。 */
  public async check(action: SandboxAction): Promise<SandboxDecision> {
    if (action.kind === 'command') {
      return this.checkCommand(action.target);
    }
    return this.checkPath(action.target);
  }

  /** 命令门禁：命中危险/网络模式即拒绝并归类。 */
  private checkCommand(command: string): SandboxDecision {
    for (const pattern of this.patterns) {
      if (pattern.test(command)) {
        const category = /\b(?:curl|wget|nc|ncat|ssh|scp)\b/i.test(command) ? 'network' : 'command';
        return { allowed: false, reason: `受限沙箱命中规则: ${pattern.source}`, category };
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
