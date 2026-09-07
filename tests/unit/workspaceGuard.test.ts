import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, symlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceGuard, PathTraversalError } from '../../src/util/workspaceGuard.js';

/** 测试用工作区。 */
const root = 'D:/omniharness/workspace';

test('路径守卫：工作区内相对路径放行', () => {
  const guard = new WorkspaceGuard(root);
  assert.strictEqual(guard.isInside('src/index.ts'), true);
  assert.strictEqual(guard.isInside('a/b/c.md'), true);
});

test('路径守卫：工作区根路径放行', () => {
  const guard = new WorkspaceGuard(root);
  assert.strictEqual(guard.isInside('.'), true);
  assert.strictEqual(guard.isInside(''), true);
});

test('路径守卫：上级目录越界拦截', () => {
  const guard = new WorkspaceGuard(root);
  assert.strictEqual(guard.isInside('../secret.txt'), false);
  assert.strictEqual(guard.isInside('../../etc/passwd'), false);
});

test('路径守卫：绝对路径越界拦截', () => {
  const guard = new WorkspaceGuard(root);
  assert.strictEqual(guard.isInside('C:/Windows/system32'), false);
  assert.strictEqual(guard.isInside('/etc/passwd'), false);
});

test('路径守卫：带前缀的相似路径不算越界', () => {
  const guard = new WorkspaceGuard(root);
  // 注意：resolve 语义下 'D:/omniharness/workspace_evil' 不会命中前缀 D:/omniharness/workspace\ 的判断
  assert.strictEqual(guard.isInside('../workspace_evil/x.txt'), false);
});

test('路径守卫：resolveSafe 对越界路径抛错', () => {
  const guard = new WorkspaceGuard(root);
  assert.throws(() => guard.resolveSafe('../secret.txt'), PathTraversalError);
  assert.throws(() => guard.resolveSafe('/etc/passwd'), PathTraversalError);
  // 区内路径返回安全绝对路径，且为字符串。
  const safe = guard.resolveSafe('src/index.ts');
  assert.strictEqual(typeof safe, 'string');
  assert.ok(!safe.includes('..'));
});

test('路径守卫：符号链接/junction 指向工作区外必须拦截', () => {
  const base = mkdtempSync(join(tmpdir(), 'wg-'));
  const outside = mkdtempSync(join(tmpdir(), 'outside-'));
  writeFileSync(join(outside, 'secret.txt'), 'topsecret');
  const link = join(base, 'escape');
  // 真实 fs 逃逸面：工作区内建软链/junction 指向工作区外。
  // Windows 下用 junction 类型（无需管理员）；Linux 下 symlink 原生可用；二者均被 realpath 展开。
  try {
    symlinkSync(outside, link, 'junction');
  } catch {
    // 极少数环境完全禁止符号链接：跳过真实逃逸用例（词法拦截用例已独立覆盖）。
    return;
  }
  const guard = new WorkspaceGuard(base);
  // 词法在内（base/escape/...），真实指向 outside/... → 必须拦截。
  assert.strictEqual(guard.isInside('escape/secret.txt'), false);
  assert.throws(() => guard.resolveSafe('escape/secret.txt'), PathTraversalError);
  // 反向：工作区内正常文件放行。
  writeFileSync(join(base, 'ok.txt'), 'hi');
  assert.strictEqual(guard.isInside('ok.txt'), true);
  assert.doesNotThrow(() => guard.resolveSafe('ok.txt'));
});

test('路径守卫：符号链接指向工作区内允许', () => {
  const base = mkdtempSync(join(tmpdir(), 'wg2-'));
  mkdirSync(join(base, 'real'));
  writeFileSync(join(base, 'real', 'data.txt'), 'inner');
  const link = join(base, 'link');
  try {
    symlinkSync(join(base, 'real'), link, 'junction');
  } catch {
    return;
  }
  const guard = new WorkspaceGuard(base);
  // 软链在区内、真实指向也在区内 → 放行。
  assert.strictEqual(guard.isInside('link/data.txt'), true);
});
