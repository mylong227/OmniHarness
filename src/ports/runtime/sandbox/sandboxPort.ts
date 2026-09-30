import type { SandboxAction } from './sandboxAction.js';
import type { SandboxDecision } from './sandboxDecision.js';

/** 沙箱端口：命令/文件访问的统一插口（可换本地/OS级/远程沙箱）。 */
export interface SandboxPort {
  readonly name: string;
  check(action: SandboxAction): Promise<SandboxDecision>;
}
