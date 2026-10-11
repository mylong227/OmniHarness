/**
 * 子进程运行的**失败分类**与**捕获预算**（从 `scripts/coverageGate.mjs` 抽出，2026-10-11）。
 *
 * 为什么要独立成模块：门禁脚本 import 即执行（顶层就跑整套测试），**无法被单测 import**；
 * 而"捕获缓冲不足"这一类失败恰恰必须有一条判据盯着——它曾把"门禁读不下输出"伪装成
 * "测试可能根本没跑起来"（2026-10-11 实测：全量套件 TAP 输出撞上 `execFileSync` 缺省的
 * 1MB `maxBuffer` ⇒ `spawnSync … ENOBUFS` ⇒ 门禁在**本来就全绿**的套件上自杀）。
 */

/**
 * 捕获子进程输出的上限（字节）。
 *
 * 门禁要看**完整 TAP**才能提取 `not ok` 行与覆盖率表 ⇒ 必须显式给足。
 * 取 64MB：约为当前全量输出的数十倍，且远低于容器内存量级。
 */
export const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;

/**
 * 把子进程失败**分类**（而不是一律归因成"测试没跑起来"）。
 *
 * @param error 捕获到的异常（`execFileSync` / `spawnSync` 抛出物）。
 * @returns 分类标签：`capture-overflow`（ENOBUFS，门禁自身读不下输出）/
 *   `spawn-failed`（ENOENT/EACCES，npm 或 shell 不在场）/ `other`（真·用例失败或汇总前崩溃）。
 */
export function classifyRunFailure(error) {
  const code = error && typeof error === 'object' ? error.code : undefined;
  const message = String((error && error.message) ?? error ?? '');
  if (code === 'ENOBUFS' || /ENOBUFS/u.test(message)) return 'capture-overflow';
  if (code === 'ENOENT' || code === 'EACCES') return 'spawn-failed';
  return 'other';
}
