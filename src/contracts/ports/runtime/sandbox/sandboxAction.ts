import type { SandboxActionKind } from './sandboxActionKind.ts';

/** 沙箱待裁决动作。 */
export interface SandboxAction {
  readonly kind: SandboxActionKind;
  readonly target: string;
}
