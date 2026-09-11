import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiffCommentStore } from '../../src/server/diffCommentStore.js';
import { RepoPathGuard } from '../../src/server/repoPathGuard.js';

function withStore<T>(fn: (ws: string, store: DiffCommentStore) => T): T {
  const ws = mkdtempSync(join(tmpdir(), 'diff-comments-'));
  try {
    const guard = new RepoPathGuard(() => ws);
    return fn(ws, new DiffCommentStore({ workspaceRoot: () => ws, guard }));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

test('DiffCommentStore：add 落盘到 .omni/diff-comments.json 并可 list 回读', () => {
  withStore((ws, store) => {
    const added = store.add({ path: 'src/a.ts', line: 3, text: '  这里要改  ', side: 'old' }) as {
      ok: boolean;
      comment: { id: string; path: string; side: string; line: number; text: string };
    };
    assert.strictEqual(added.ok, true);
    assert.strictEqual(added.comment.path, join('src', 'a.ts'));
    assert.strictEqual(added.comment.side, 'old');
    assert.strictEqual(added.comment.line, 3);
    assert.strictEqual(added.comment.text, '这里要改', 'text 应被 trim');

    assert.ok(existsSync(join(ws, '.omni', 'diff-comments.json')), '应创建 .omni/diff-comments.json');
    const listed = store.list() as { comments: { id: string }[] };
    assert.strictEqual(listed.comments.length, 1);
    assert.strictEqual(listed.comments[0]?.id, added.comment.id);
  });
});

test('DiffCommentStore：add 默认 side=new，且拒绝非法入参', () => {
  withStore((_ws, store) => {
    const added = store.add({ path: 'a.ts', line: 0, text: 'x' }) as {
      comment: { side: string };
    };
    assert.strictEqual(added.comment.side, 'new');

    assert.throws(() => store.add({ path: 'a.ts', line: 0, text: '   ' }), /需要非空 path 与 text/);
    assert.throws(() => store.add({ path: 'a.ts', line: 0 }), /需要非空 path 与 text/);
    assert.throws(
      () => store.add({ path: 'a.ts', line: 1.5, text: 'x' }),
      /需要非负整数 line/,
    );
    assert.throws(() => store.add({ path: 'a.ts', line: -1, text: 'x' }), /需要非负整数 line/);
    assert.throws(
      () => store.add({ path: '../evil.ts', line: 0, text: 'x' }),
      /路径越出仓库范围/,
    );
  });
});

test('DiffCommentStore：remove 命中返回 ok，未命中抛错', () => {
  withStore((_ws, store) => {
    const added = store.add({ path: 'a.ts', line: 1, text: 'x' }) as { comment: { id: string } };
    assert.deepStrictEqual(store.remove({ id: added.comment.id }), { ok: true });
    assert.strictEqual((store.list() as { comments: unknown[] }).comments.length, 0);
    assert.throws(() => store.remove({ id: 'nope' }), /未找到评论: nope/);
    assert.throws(() => store.remove({}), /需要 id/);
  });
});

test('DiffCommentStore：文件损坏 fail-open 到空态，且过滤结构非法记录', () => {
  withStore((ws, store) => {
    const dir = join(ws, '.omni');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'diff-comments.json'), '{ not json', 'utf8');
    assert.deepStrictEqual(store.list(), { comments: [] }, '损坏 JSON 应回退空数组');

    writeFileSync(
      join(dir, 'diff-comments.json'),
      JSON.stringify([
        { id: 'k', path: 'a.ts', side: 'new', line: 1, text: 't', ts: 'now' },
        { id: 'bad', path: 'a.ts', side: 'sideways', line: 1, text: 't', ts: 'now' },
        { id: 'short' },
      ]),
      'utf8',
    );
    const listed = store.list() as { comments: { id: string }[] };
    assert.deepStrictEqual(
      listed.comments.map((c) => c.id),
      ['k'],
      '仅保留结构合法的记录',
    );
  });
});

test('DiffCommentStore：写入为可读 JSON（round-trip 一致）', () => {
  withStore((ws, store) => {
    store.add({ path: 'a.ts', line: 5, text: 'hello' });
    const raw = JSON.parse(readFileSync(join(ws, '.omni', 'diff-comments.json'), 'utf8')) as {
      text: string;
    }[];
    assert.strictEqual(raw[0]?.text, 'hello');
  });
});
