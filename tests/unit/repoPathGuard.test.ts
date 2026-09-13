import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RepoPathGuard } from '../../src/server/services/repoPathGuard.js';

function withWorkspace<T>(fn: (ws: string, guard: RepoPathGuard) => T): T {
  const ws = mkdtempSync(join(tmpdir(), 'repo-guard-'));
  try {
    return fn(ws, new RepoPathGuard(() => ws));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

test('RepoPathGuard.resolve：放行仓库内相对路径并规范化 . 前缀', () => {
  withWorkspace((_ws, guard) => {
    // 返回值沿用 path.relative 的原生分隔符（Windows 为 \\），与重构前行为逐字一致。
    assert.strictEqual(guard.resolve('src/a.ts'), join('src', 'a.ts'));
    assert.strictEqual(guard.resolve('a/b/c.ts'), join('a', 'b', 'c.ts'));
    assert.strictEqual(guard.resolve('./src/a.ts'), join('src', 'a.ts'), './ 前缀应被规范化掉');
  });
});

test('RepoPathGuard.resolve：拒绝空串', () => {
  withWorkspace((_ws, guard) => {
    assert.throws(() => guard.resolve(''), /path 不能为空/);
  });
});

test('RepoPathGuard.resolve：拒绝绝对路径与盘符路径（fail-closed）', () => {
  withWorkspace((_ws, guard) => {
    assert.throws(() => guard.resolve('/etc/passwd'), /仅接受仓库内相对路径/);
    assert.throws(() => guard.resolve('C:\\Windows\\system32'), /仅接受仓库内相对路径/);
  });
});

test('RepoPathGuard.resolve：拒绝 .. 穿越与越出仓库范围', () => {
  withWorkspace((_ws, guard) => {
    assert.throws(() => guard.resolve('../evil'), /路径越出仓库范围/);
    assert.throws(() => guard.resolve('a/../../b'), /路径越出仓库范围/);
  });
});

test('RepoPathGuard.resolve：工作区根以 getter 求值（切换后立即生效）', () => {
  const first = mkdtempSync(join(tmpdir(), 'repo-guard-a-'));
  const second = mkdtempSync(join(tmpdir(), 'repo-guard-b-'));
  try {
    let current = first;
    const guard = new RepoPathGuard(() => current);
    assert.strictEqual(guard.resolve('x.ts'), 'x.ts');
    current = second;
    assert.strictEqual(
      guard.resolve('x.ts'),
      'x.ts',
      '切换工作区后同一相对路径仍合法（守卫每次重新求值根）',
    );
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});
