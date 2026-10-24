#!/usr/bin/env node
/**
 * 检查点快照清扫（2026-10-23）。
 *
 * 背景：`GitWorkspaceSnapshot` 现在有单文件/总量上限，但**历史** `.omni-checkpoints`
 * 里的旧快照不会自动消失；本机实测曾到 507.9 MB（单文件 161.3 MB）。本脚本按 mtime
 * 清理超龄的 `<session>/<label>.files.json`，默认 **dry-run**。
 *
 * 用法：
 *   node scripts/checkpointSweep.mjs                 # 预览将删除什么
 *   node scripts/checkpointSweep.mjs --apply         # 真删
 *   node scripts/checkpointSweep.mjs --older-than-days 7 --apply
 *   node scripts/checkpointSweep.mjs --dir D:\ws\.omni-checkpoints --json
 *
 * 边界：
 * - 只处理指定目录下的 `<session>/<label>.files.json`，不碰其它文件；
 * - 只按**文件** mtime 判断，不删除整个会话目录（清空后目录自然为空，可选删空目录）；
 * - 符号链接跳过；删除失败只记录，不中断。
 */
import { readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};

const dir = resolve(value('dir', join(process.cwd(), '.omni-checkpoints')));
const apply = flag('apply');
const json = flag('json');
const olderDaysRaw = Number(value('older-than-days', '14'));
const olderDays = Number.isFinite(olderDaysRaw) && olderDaysRaw >= 0 ? olderDaysRaw : 30;
const cutoff = Date.now() - olderDays * 24 * 60 * 60 * 1000;

let sessions;
try {
  sessions = await readdir(dir, { withFileTypes: true });
} catch (error) {
  console.error(`[checkpointSweep] 目录不可读：${dir}（${String(error)}）`);
  process.exit(2);
}

const removed = [];
const kept = [];
for (const entry of sessions) {
  if (!entry.isDirectory()) continue;
  const sessionDir = join(dir, entry.name);
  let files;
  try {
    files = await readdir(sessionDir, { withFileTypes: true });
  } catch {
    continue;
  }
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith('.files.json')) continue;
    const path = join(sessionDir, file.name);
    try {
      const info = await stat(path);
      if (info.mtimeMs >= cutoff) {
        kept.push({ path, bytes: info.size });
        continue;
      }
      if (apply) await rm(path, { force: true });
      removed.push({ path, bytes: info.size });
    } catch (error) {
      // 并发删除/权限：只记录，不中断。
      kept.push({ path, bytes: 0, error: String(error) });
    }
  }
}

const bytes = removed.reduce((sum, item) => sum + item.bytes, 0);
if (json) {
  console.log(
    JSON.stringify(
      {
        dir,
        apply,
        olderThanDays: olderDays,
        removed,
        kept,
        removedBytes: bytes,
        removedCount: removed.length,
      },
      null,
      2,
    ),
  );
} else {
  console.log(
    `[checkpointSweep] ${apply ? '已删除' : '将删除'} ${removed.length} 个快照，` +
      `${(bytes / 1024 / 1024).toFixed(1)} MiB（阈值：${olderDays} 天前；目录：${dir}）`,
  );
  for (const item of removed.slice(0, 20)) {
    console.log(`  - ${item.path} (${(item.bytes / 1024 / 1024).toFixed(2)} MiB)`);
  }
  if (removed.length > 20) console.log(`  … 其余 ${removed.length - 20} 个`);
  if (!apply) console.log('  （dry-run；确认后加 --apply）');
}
