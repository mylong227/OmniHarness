import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Worker 线程入口解析器：**编译产物优先，源码回落**。
 *
 * ## 为什么需要它（2026-10-17 测试栈统一）
 *
 * Worker 的入口 historically 写死 `new URL('./x.js', import.meta.url)` —— 在「源码经 tsc
 * 编译到 dist 再运行」的形态下，`.js` 兄弟文件天然存在。但测试栈统一后 vitest **直跑源码**，
 * `import.meta.url` 指向源码树，同级只有 `.ts` —— 写死的 `.js` 必然 ENOENT。
 *
 * 规则：先找 `.js`（生产/编译态，按字面命中）；不存在则回落 `.ts`（vitest 源码态）。
 * 回落态要求创建该 Worker 的进程带 `--experimental-strip-types`（Node ≥22.6；本仓
 * 源码导入全部写真实 `.ts` 后缀，恰好满足 strip-types 的硬要求）。该旗标由 vitest 的
 * `poolOptions.forks.execArgv` 下发（见 vitest.workspace.ts），Worker 线程默认继承
 * 创建进程的 execArgv。
 */
export class WorkerEntryUrl {
  /**
   * 解析与 `fromModuleUrl` 同目录的 worker 入口。
   * @param fromModuleUrl 调用方模块的 `import.meta.url`
   * @param baseName 入口文件名（不含扩展名，如 `'builtinWasmWorker'`）
   * @returns 存在的入口 URL（`.js` 优先，回落 `.ts`）
   */
  public static resolve(fromModuleUrl: string, baseName: string): URL {
    const compiled = new URL(`./${baseName}.js`, fromModuleUrl);
    if (existsSync(fileURLToPath(compiled))) return compiled;
    return new URL(`./${baseName}.ts`, fromModuleUrl);
  }
}
