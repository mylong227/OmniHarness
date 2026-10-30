import { rmSync } from 'node:fs';

/** 异步落盘（旁路摘要等）与清理的竞态宽限：第一轮删不动时等这段时间再试。 */
const GRACE_MS = 300;

/**
 * 测试临时目录的**尽力而为**清理（never throw）。
 *
 * ## 为什么需要它
 *
 * 会话存档的旁路摘要（`<session>.jsonl.summary.json`）与索引侧车是**异步**写入的：
 * 行为断言已结束、测试开始删目录时，一次迟到的 `writeFile` 会让 Windows 报
 * `ENOTEMPTY`——2026-10-31 全量套件两次实测（`omni-sess-scope-*`、maxRetries=5
 * 的 100ms 重试窗都被 >100ms 的迟到写穿透）。仓库先例（`tempWorkspace.ts`）的口径是
 * 「清理失败不影响退出码，OS 临时目录兜底」；本 helper 把同一口径显式化：
 *
 *  1. 第一轮 `rmSync`（10 次 × 50ms 重试窗）；
 *  2. 仍不动 ⇒ 给异步写 300ms 宽限后再来一轮；
 *  3. 仍不动 ⇒ **放弃并继续**——目录名带 `omni-` 前缀，仓内 gc 清扫器
 *     （`omniharness gc`：`omni-*` 家族 + 24h 阈值）会兜底回收。
 *
 * 清理永远不该反过来把行为断言已通过的测试判红。
 * @param dir 临时目录绝对路径。
 */
export async function rmTempBestEffort(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, GRACE_MS));
    }
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      return;
    } catch {
      /* 再试或放弃（见上） */
    }
  }
}
