/**
 * watcher 变更路径追踪（F1 部分，2026-10-25）。
 *
 * 钉住两件事：路径归一化（反斜杠/`./`）与"文件名不可用 ⇒ 必须全量复核"的哨兵语义。
 * 缓存层的「只复核变更路径」依赖这两条；哨兵丢了就会把未知变更误判成"没变"。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { CorpusWatchRegistry } from '../../src/context/corpusWatchRegistry.ts';

const ROOT = process.cwd();

test('变更路径：反斜杠与 ./ 归一化为 POSIX 相对路径', () => {
  const watch = new CorpusWatchRegistry(false);
  watch.markChanged(ROOT, 'src\\context\\corpusIndexCache.ts');
  watch.markChanged(ROOT, './README.md');
  const paths = watch.changedPaths(ROOT);
  assert.deepEqual([...(paths ?? [])].sort(), ['README.md', 'src/context/corpusIndexCache.ts']);
  assert.strictEqual(watch.isDirty(ROOT), true);
  watch.clearDirty(ROOT);
  assert.strictEqual(watch.isDirty(ROOT), false);
  assert.strictEqual(watch.changedPaths(ROOT), undefined);
});

test('变更路径：文件名不可用 ⇒ 空串哨兵 ⇒ changedPaths 返回 undefined', () => {
  const watch = new CorpusWatchRegistry(false);
  watch.markChanged(ROOT, 'src/a.ts');
  watch.markChanged(ROOT, null);
  assert.strictEqual(watch.changedPaths(ROOT), undefined);
});

test('变更路径：没有变更时返回 undefined（不伪造空集合）', () => {
  const watch = new CorpusWatchRegistry(false);
  assert.strictEqual(watch.changedPaths(ROOT), undefined);
});

test('观测计数：pathReuses 独立于 fullHashes/statReuses', () => {
  const watch = new CorpusWatchRegistry(false);
  const before = watch.stats();
  watch.notePathReuse();
  const after = watch.stats();
  assert.strictEqual(after.pathReuses, before.pathReuses + 1);
  assert.strictEqual(after.fullHashes, before.fullHashes);
  assert.strictEqual(after.statReuses, before.statReuses);
});
