/**
 * @beta
 * 子代理 worker 契约（**桶再导出**）。
 *
 * 2026-10-11：三个接口已外迁 `ports/worker/worker.ts`——`ports/config/omniHarnessConfig.ts`
 * 需要 `WorkerRegistry` 的契约，而端口不得反向依赖实现文件。本文件保留同名导出以维持
 * 公共 API 面零改动（该模块编译产物仍是 `export {};`，零执行行）。
 */
export type { Worker, WorkerRequest, WorkerResult } from '../ports/worker/worker.js';
