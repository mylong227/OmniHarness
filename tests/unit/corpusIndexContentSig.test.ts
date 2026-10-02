import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, utimesSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CorpusIndexCache } from '../../src/context/corpusIndexCache.js';

/**
 * 造一个最小可索引的工作区（`ContextEngine` 只认 `.ts` / `.js` / `.py`）。
 * 文件名以 `_test_` 开头，避免与真实源码混淆。
 * @returns 临时目录绝对路径（调用方负责 rmSync 清理）。
 */
const workspace = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-corpus-sig-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  return dir;
};

/** 写入一个可被符号抽取的 TS 文件。
 * @param root 工作区根。
 * @param rel 相对路径。
 * @param body 文件正文。
 * @returns 无返回值。
 */
const write = (root: string, rel: string, body: string): void => {
  writeFileSync(join(root, rel), body, 'utf8');
};

/** 在环境变量 scoped 执行（跑完必还原，避免污染同进程其它用例）。
 * @param key 变量名。
 * @param value 值（undefined 表示删除）。
 * @param fn 被测逻辑。
 * @returns fn 的返回值。
 */
const withEnv = <T>(key: string, value: string | undefined, fn: () => T): T => {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
};

test('CorpusIndexCache: TTL 到期但内容逐字不变 ⇒ 复用同一语料实例（不再重建）', () => {
  const root = workspace();
  try {
    write(root, 'src/a_test_x.ts', 'export class AlphaTestX { run(): void {} }\n');
    // TTL=0 ⇒ 每次 get 都必须走「内容签名比对」这条路径（正是本用例要钉的判据）。
    withEnv('OMNI_REPO_MAP_TTL_MS', '0', () => {
      const cache = new CorpusIndexCache({ maxEntries: 4 });
      const first = cache.get(root);
      assert.notStrictEqual(first, null);
      const second = cache.get(root);
      // 同一实例 = 没有重建。若这里退回「TTL 到期即全量重建」，对象引用会变。
      assert.strictEqual(second, first);
      assert.deepEqual(cache.stats(), { hits: 1, misses: 1, entries: 1 });
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CorpusIndexCache: 只改 mtime、内容不变 ⇒ 仍复用（mtime 不再是失效判据）', () => {
  const root = workspace();
  try {
    const file = join(root, 'src', 'a_test_x.ts');
    write(root, 'src/a_test_x.ts', 'export class AlphaTestX { run(): void {} }\n');
    withEnv('OMNI_REPO_MAP_TTL_MS', '0', () => {
      const cache = new CorpusIndexCache({ maxEntries: 4 });
      const first = cache.get(root);
      assert.notStrictEqual(first, null);
      // 把 mtime 推到过去一小时：`touch` / `git checkout` / 备份回写都会造成这种「伪变更」。
      const past = new Date(Date.now() - 3600_000);
      utimesSync(file, past, past);
      const second = cache.get(root);
      assert.strictEqual(
        second,
        first,
        'mtime 变了但内容没变 ⇒ 不应重建（这正是 mtime 判据的假阳性）',
      );
      assert.strictEqual(cache.stats().misses, 1);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CorpusIndexCache: 内容变了（即便 mtime 被回填成原值）⇒ 必须重建', () => {
  const root = workspace();
  try {
    const file = join(root, 'src', 'a_test_x.ts');
    write(root, 'src/a_test_x.ts', 'export class AlphaTestX { run(): void {} }\n');
    withEnv('OMNI_REPO_MAP_TTL_MS', '0', () => {
      const cache = new CorpusIndexCache({ maxEntries: 4 });
      const first = cache.get(root);
      assert.notStrictEqual(first, null);
      const stamps = { atime: new Date(1_600_000_000_000), mtime: new Date(1_600_000_000_000) };
      utimesSync(file, stamps.atime, stamps.mtime);
      // 改内容后把 mtime **原样回填** —— 同毫秒多次落盘 / 粗粒度文件系统下的真实形态。
      write(root, 'src/a_test_x.ts', 'export class BetaTestX { run(): void {} }\n');
      utimesSync(file, stamps.atime, stamps.mtime);
      const second = cache.get(root);
      assert.notStrictEqual(second, null);
      assert.notStrictEqual(
        second,
        first,
        '内容变了但 mtime 相同 ⇒ 必须重建（这正是 mtime 判据的假阴性、也是最危险的一侧）',
      );
      assert.deepEqual(cache.stats(), { hits: 0, misses: 2, entries: 1 });
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CorpusIndexCache: 新增文件（内容集合变化）⇒ 重建', () => {
  const root = workspace();
  try {
    write(root, 'src/a_test_x.ts', 'export class AlphaTestX { run(): void {} }\n');
    withEnv('OMNI_REPO_MAP_TTL_MS', '0', () => {
      const cache = new CorpusIndexCache({ maxEntries: 4 });
      const first = cache.get(root);
      write(root, 'src/b_test_y.ts', 'export class BetaTestY { run(): void {} }\n');
      const second = cache.get(root);
      assert.notStrictEqual(second, null);
      assert.notStrictEqual(second, first);
      assert.strictEqual(second?.files.length, 2);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CorpusIndexCache: clear(root) 之后即便内容未变也重建（显式失效优先于签名比对）', () => {
  const root = workspace();
  try {
    write(root, 'src/a_test_x.ts', 'export class AlphaTestX { run(): void {} }\n');
    withEnv('OMNI_REPO_MAP_TTL_MS', '0', () => {
      const cache = new CorpusIndexCache({ maxEntries: 4 });
      const first = cache.get(root);
      cache.clear(root);
      const second = cache.get(root);
      assert.notStrictEqual(second, null);
      assert.notStrictEqual(second, first);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
