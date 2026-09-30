import type { SandboxActionKind } from './sandboxActionKind.js';

/** 沙箱待裁决动作。 */
export interface SandboxAction {
  readonly kind: SandboxActionKind;
  readonly target: string;
}
