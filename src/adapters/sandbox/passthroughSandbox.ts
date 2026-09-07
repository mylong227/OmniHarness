import type { SandboxAction, SandboxDecision, SandboxPort } from '../../ports/sandbox.js';

/** 直通沙箱适配器：默认放行一切（M0 兜底，生产环境请替换为 OS 级沙箱）。 */
export class PassthroughSandbox implements SandboxPort {
  readonly name = 'passthrough';

  /** 全部放行。 */
  async check(_action: SandboxAction): Promise<SandboxDecision> {
    return { allowed: true };
  }
}
