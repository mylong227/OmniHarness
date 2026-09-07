// 原生内核（FFI 下沉 #65）统一导出。

export { NativeKernel, NativeKernelUnavailableError } from './nativeKernel.js';
export type { NativeDecision } from './nativeKernel.js';
export { NativeBackend } from './nativeBackend.js';
export type { NativeToolRunner } from './nativeBackend.js';
