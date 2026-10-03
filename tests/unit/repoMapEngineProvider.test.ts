/**
 * repo-map 引擎的**进程级复用**与**软失效**单测（2026-10-03 修）。
 *
 * 两个缺陷现场：
 *  ① 装配层此前在每个组合根（`ConfigFactory.build`）与每个子代理里 `new RepoMapContextEngine()`，
 *     缓存生命期退化成「一次装配」⇒ 每次装配重索引全仓（实测 8.6s 量级）。代价实测：
 *     `sessionLifecycle.test.ts` 6 个用例 100s、`workflowRunner.test.ts` 超 120s 被 cancelled，
 *     官方门禁 `npm test` **exit 1**。修后两者分别 14.2s / 10.5s。
 *  ② 写类工具成功后走 `clear()` 硬删 ⇒ 下一次组装上下文**必然**全量重建，而 `shell` 里跑
 *     `echo` / `git status` 并不改被索引的源码。改为软失效（`invalidate`）后先比内容签名。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RepoMapEngineProvider } from '../../src/context/repoMap/repoMapEngineProvider.js';
import { RepoMapContextEngine } from '../../src/context/repoMap/repoMapContextEngine.js';

/**
 * 造一个最小可索引工作区（`ContextEngine` 只认 .ts/.js/.py）。
 * @returns 临时目录绝对路径（调用方负责清理）。
 */
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omni-engine-provider-'));
  writeFileSync(join(dir, 'probe.ts'), 'export class ProbeAlpha { run(): void {} }\n', 'utf8');
  return dir;
}

test('RepoMapEngineProvider：多次取用恒返回同一实例（缓存跨装配复用才可能）', () => {
  RepoMapEngineProvider.reset();
  const first = RepoMapEngineProvider.engine();
  const second = RepoMapEngineProvider.engine();
  assert.ok(first instanceof RepoMapContextEngine);
  assert.strictEqual(first, second, '同一进程内必须复用同一引擎实例');
});

test('RepoMapEngineProvider：reset 后重建新实例（仅测试隔离用）', () => {
  const first = RepoMapEngineProvider.engine();
  RepoMapEngineProvider.reset();
  assert.notStrictEqual(first, RepoMapEngineProvider.engine());
});

test('引擎软失效：写类工具后调用 invalidate，内容未变时复用既有语料（不再白付 8.6s 重建）', () => {
  const root = workspace();
  const previous = process.env['OMNI_REPO_MAP_TTL_MS'];
  process.env['OMNI_REPO_MAP_TTL_MS'] = '0';
  try {
    const engine = new RepoMapContextEngine();
    assert.notStrictEqual(engine.getRepoMapContext(root, 'ProbeAlpha'), null);
    engine.invalidate(root);
    assert.notStrictEqual(engine.getRepoMapContext(root, 'ProbeAlpha'), null);
    const stats = engine.cacheStats()['CorpusIndexCache'];
    assert.deepStrictEqual(
      { hits: stats?.hits, misses: stats?.misses },
      { hits: 1, misses: 1 },
      '第二次必须算「命中」（软失效先复核内容签名，未变即复用）',
    );
  } finally {
    if (previous === undefined) delete process.env['OMNI_REPO_MAP_TTL_MS'];
    else process.env['OMNI_REPO_MAP_TTL_MS'] = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('引擎软失效：内容真变时照样重建（陈旧窗口为零，不是绕过复核）', () => {
  const root = workspace();
  const previous = process.env['OMNI_REPO_MAP_TTL_MS'];
  process.env['OMNI_REPO_MAP_TTL_MS'] = '0';
  try {
    const engine = new RepoMapContextEngine();
    const before = engine.getRepoMapContext(root, 'ProbeAlpha');
    assert.notStrictEqual(before, null);
    writeFileSync(join(root, 'probe.ts'), 'export class ProbeBeta { run(): void {} }\n', 'utf8');
    engine.invalidate(root);
    const after = engine.getRepoMapContext(root, 'ProbeBeta');
    assert.ok(after !== null, '真变化后必须仍能产出上下文');
    assert.match(after, /ProbeBeta/, '真变化必须重建，检索到新符号');
    const stats = engine.cacheStats()['CorpusIndexCache'];
    assert.strictEqual(stats?.misses, 2, '两次都应是未命中（第一次建索引、第二次内容变）');
  } finally {
    if (previous === undefined) delete process.env['OMNI_REPO_MAP_TTL_MS'];
    else process.env['OMNI_REPO_MAP_TTL_MS'] = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
