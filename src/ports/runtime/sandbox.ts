/**
 * 沙箱端口契约聚合（桶）。
 *
 * 本文件已退化为桶：5 个接口各自独立成文件于 `./sandbox/`，调用点零改动。
 */

export type { SandboxActionKind } from './sandbox/sandboxActionKind.js';
export type { SandboxDenialCategory } from './sandbox/sandboxDenialCategory.js';
export type { SandboxAction } from './sandbox/sandboxAction.js';
export type { SandboxDecision } from './sandbox/sandboxDecision.js';
export type { SandboxPort } from './sandbox/sandboxPort.js';
