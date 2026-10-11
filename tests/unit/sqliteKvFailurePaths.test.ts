/**
 * `SqliteKv` 的**两条失败路径**判据（2026-10-11）。
 *
 * ## 为什么补它（并推翻上一轮的纸面处置）
 *
 * `SqliteKv` 的 `loadDatabaseSync()` 有两条失败路径：① `node:sqlite` 模块加载抛错（老 Node）；
 * ② 模块加载成功但**未导出 `DatabaseSync`**（形态变了/被 polyfill 顶掉）。两条都产出
 * **可行动的**错误文案（"改用 `--kv-adapter json-file` 或升级 Node"）——那是真实能力。
 *
 * 但它们在装了 Node 22 的环境里不可达，于是上一轮我把该文件的覆盖率冻结值直接改写（100 → 95.41）
 * 并在 notes 里写了理由。**那是纸面处置**：能力仍在却无人守，谁把错误文案删了都不会红。
 * 现改为给 `SqliteKv.requireImpl` 加**可注入的缝**，判据直接把加载器换成替身——
 * 走的是 `loadDatabaseSync` 的**原逻辑**（不是包一层），两条路径都能被真实触发。
 *
 * ## 判据口径
 *
 * ① 真实路径（反面对照）：**不注入**时构造必须成功且全部 KV 操作可用——否则下面"失败路径"的
 *    断言可能只是因为"构造本来就总是抛"；② 加载器抛错 ⇒ 文案含 `node:sqlite` 与 `json-file`；
 * ③ 加载器返回**不含 `DatabaseSync`** 的对象 ⇒ 同一文案（覆盖 `typeof !== 'function'` 分支）；
 * ④ 两条路径之后**必须恢复替身**（`finally`），且恢复后构造仍成功（防判据把进程状态弄脏）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteKv } from '../../src/adapters/kv/sqliteKv.js';

/**
 * 在替换了 `SqliteKv.requireImpl` 的窗口内跑一段断言，结束即恢复。
 * @param impl 替身加载器。
 * @param fn 断言体。
 * @returns 无返回值。
 */
function withRequireImpl(impl: (specifier: string) => unknown, fn: () => void): void {
  const original = SqliteKv.requireImpl;
  SqliteKv.requireImpl = impl;
  try {
    fn();
  } finally {
    SqliteKv.requireImpl = original;
  }
}

/** 一个可用的临时库路径。 */
function tempDbPath(): {
  readonly path: string;
  readonly cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'omni-sqlitekv-'));
  return {
    path: join(dir, 'kv.sqlite'),
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        /* Windows node:sqlite 句柄释放延迟，忽略（与 tests/unit/sqliteStorage.test.ts:32-36 同一口径） */
      }
    },
  };
}

test('① 反面对照：不注入时构造成功且 KV 全操作可用（否则下面的失败路径断言毫无意义）', async () => {
  const { path, cleanup } = tempDbPath();
  try {
    const kv = new SqliteKv(path);
    await kv.set('alpha', 'one');
    await kv.set('beta', 'two');
    await kv.set('alpha', 'one2');
    assert.strictEqual(await kv.get('alpha'), 'one2', '覆盖写应生效');
    assert.strictEqual(await kv.get('missing'), undefined);
    assert.strictEqual(await kv.has('beta'), true);
    assert.strictEqual(await kv.has('missing'), false);
    assert.deepStrictEqual(await kv.keys(), ['alpha', 'beta'], 'keys 必须按字典序');
    assert.deepStrictEqual(await kv.list('a'), [{ key: 'alpha', value: 'one2' }]);
    assert.strictEqual(await kv.delete('beta'), true);
    assert.strictEqual(await kv.delete('beta'), false, '删除不存在的键必须返回 false');
    await kv.close();
  } finally {
    cleanup();
  }
});

test('② 加载器抛错 ⇒ 抛出可行动文案（含模块名与替代后端）', () => {
  const { path, cleanup } = tempDbPath();
  try {
    withRequireImpl(
      () => {
        throw new Error('MODULE_NOT_FOUND');
      },
      () => {
        assert.throws(
          () => new SqliteKv(path),
          (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            assert.match(message, /node:sqlite/, `文案必须点明缺哪个模块：${message}`);
            assert.match(message, /json-file/, `文案必须给出替代后端（可行动）：${message}`);
            assert.match(message, /Node/, `文案必须点明版本要求：${message}`);
            return true;
          },
        );
      },
    );
  } finally {
    cleanup();
  }
});

test('③ 模块加载成功但未导出 DatabaseSync ⇒ 同一可行动文案（覆盖 typeof 分支）', () => {
  const { path, cleanup } = tempDbPath();
  try {
    withRequireImpl(
      () => ({ notDatabaseSync: true }),
      () => {
        assert.throws(
          () => new SqliteKv(path),
          (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            assert.match(message, /node:sqlite/);
            assert.match(message, /json-file/);
            return true;
          },
        );
      },
    );
  } finally {
    cleanup();
  }
});

test('④ 替身必须被恢复：两条失败路径之后构造仍能成功（判据不得弄脏进程状态）', async () => {
  assert.strictEqual(
    SqliteKv.requireImpl('node:sqlite') !== undefined,
    true,
    '替身未被恢复（requireImpl 仍指向测试替身）',
  );
  const { path, cleanup } = tempDbPath();
  try {
    const kv = new SqliteKv(path);
    await kv.set('k', 'v');
    assert.strictEqual(await kv.get('k'), 'v');
    await kv.close();
  } finally {
    cleanup();
  }
});
