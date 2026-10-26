/**
 * 本仓 web 测试的临时目录卫生（2026-10-26，C 盘 Temp 19 GB 爆炸的源头修复）。
 *
 * ## 为什么需要（实测事故）
 *
 * web 真 Chrome e2e 每次运行在 OS Temp 建 `omni-cdp-*`（Chrome profile，几十 MB/个）与
 * `omni-crash-*`（崩溃转储）；收尾的 `rmSync` 在 Chrome 文件锁尚未释放时**静默失败**
 * （原注释写"交由 OS 回收"——Windows 对 Temp 目录从来自动回收，这条假设不成立）。
 * 实测积压：`omni-cdp-*` ×1000 = 9.2 GB、`omni-crash-*` ×114 = 1.1 GB。
 *
 * ## 三道防线（本助手承载前两道，第三道在生产清扫器 `TmpSweep`）
 *
 * 1. **删除带锁重试**：`rmRfRetry`——Chrome 进程树杀掉后锁释放有滞后，重试几轮能救回绝大多数；
 * 2. **创建前顺手收尸**：`makeOmniTemp` 每次建目录前先清超龄（>24h）孤儿——正在跑的进程
 *    的目录都很年轻，不会被误删；
 * 3. 生产侧兜底：这些前缀已登记进 `src/util/tmpSweep.ts`，serve 启动/周期与 `gc` 命令也会清。
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 本仓 web 测试产生的临时前缀（与生产 `TmpSweep.DEFAULT_PREFIXES` 对应子集一致）。 */
export const OMNI_TEMP_PREFIXES: readonly string[] = [
  'omni-cdp-',
  'omni-crash-',
  'omni-live-ui-',
  'omni-long-',
];

/** 缺省年龄阈值：24h（正在跑的用例绝不会超龄）。 */
const DEFAULT_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * 清扫各根下超龄的本仓临时孤儿。
 * @param olderThanMs 年龄阈值。
 * @param roots 扫描根（缺省 OS Temp）。
 * @returns 删除数。
 */
export function sweepStaleOmniTemp(
  olderThanMs: number = DEFAULT_AGE_MS,
  roots: readonly string[] = [tmpdir()],
): number {
  const now = Date.now();
  let removed = 0;
  for (const root of roots) {
    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!OMNI_TEMP_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
      const path = join(root, name);
      try {
        const stat = statSync(path);
        if (now - stat.mtimeMs < olderThanMs) continue;
        if (stat.isDirectory()) rmSync(path, { recursive: true, force: true, maxRetries: 3 });
        else unlinkSync(path);
        removed += 1;
      } catch {
        /* 被锁/已被删：留给下一次 */
      }
    }
  }
  return removed;
}

/**
 * 建测试临时目录（前缀必须在 {@link OMNI_TEMP_PREFIXES} 名单内），创建前顺手收尸。
 * @param prefix 目录前缀。
 * @returns 绝对路径。
 */
export function makeOmniTemp(prefix: string): string {
  sweepStaleOmniTemp();
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * 带锁重试的强删（Windows 下 Chrome 锁释放滞后 ⇒ 单次 rmSync 常失败且**无声**）。
 * @param path 目录/文件。
 * @param retries 重试轮数（缺省 3）。
 * @param delayMs 每轮间隔（缺省 250ms）。
 * @returns 无返回值；最终仍失败留给清扫器兜底，绝不向上抛（收尾不能把用例打红）。
 */
export function rmRfRetry(path: string, retries = 3, delayMs = 250): void {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      if (!existsSync(path)) return;
      rmSync(path, { recursive: true, force: true, maxRetries: 2 });
      return;
    } catch {
      if (attempt < retries) {
        // 同步毫秒级睡眠（Atomics.wait 是 Node 下无依赖的同步 sleep 惯用法）。
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
      }
    }
  }
}
