/**
 * 沙箱端口契约聚合（桶）。
 *
 * 本文件已退化为桶：5 个接口各自独立成文件于 `./sandbox/`，调用点零改动。
 */

export type { SandboxActionKind } from './sandbox/sandboxActionKind.ts';
export type { SandboxDenialCategory } from './sandbox/sandboxDenialCategory.ts';
export type { SandboxAction } from './sandbox/sandboxAction.ts';
export type { SandboxDecision } from './sandbox/sandboxDecision.ts';
export type { SandboxPort } from './sandbox/sandboxPort.ts';
