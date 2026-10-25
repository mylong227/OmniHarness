// 原生内核（FFI 下沉 #65）统一导出。

export { NativeKernel, NativeKernelUnavailableError } from './nativeKernel.ts';
export type { NativeDecision } from './nativeKernel.ts';
export { NativeBackend } from './nativeBackend.ts';
export type { NativeToolRunner } from './nativeBackend.ts';
export { OmniCliLocator } from './omniCliLocator.ts';
