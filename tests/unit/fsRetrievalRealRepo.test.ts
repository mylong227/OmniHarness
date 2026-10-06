/**
 * `glob` / `grep` 在**真实仓库**上必须真的能取到数（2026-10-06 第六十轮真实 API 跑测暴露）。
 *
 * ## 它锁的是什么
 *
 * 一次真实 API 跑测里，agent 反复调"递归列出 `src` 下 `.ts`"的 glob 得到"（无命中）"、调
 * `grep path=src` 得到"路径不存在: src"，而 `list_dir src` 明明正常 —— 于是模型断定"文件不存在"，
 * **浪费 16 步**后只能回"未能确定"。根因不是权限也不是路径：`WorkspaceFileWalker` 的
 * **20000 文件上限被 `third-party/`（本机 19770 个文件，harness 自己的权重/向量缓存）吃满**，
 * 遍历**根本没走到 `src/`**。
 *
 * | # | 判据 |
 * | --- | --- |
 * | ① | 真实仓库上 `glob src/**\\/*.ts` 必须**命中 ≥1 个真实文件**（修复前恒 0） |
 * | ② | 真实仓库上 `grep`（`path=src/cli`, `glob=*.ts`）必须**命中 ≥1 处**（修复前恒 0） |
 * | ③ | 忽略清单必须含 harness 自己的缓存/资产目录（`third-party` / `.cache` / `.omniharness`）——它们是**二进制资产**，不该与源码争遍历预算 |
 * | ④ | 遍历被截断且零命中 ⇒ 工具必须 **fail-loud**（`ok:false`），不许把"0 命中"当成结论给模型 |
 *
 * 判据①②是**真实仓库上的行为断言**（不是"函数返回了字符串"这种弱判据）：它们正是本次缺陷的
 * 现场形态——用小夹具永远测不出来，因为夹具里没有"近两万文件的缓存目录"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrepTool } from '../../src/adapters/tool/fs/grepTool.js';
import { GlobTool } from '../../src/adapters/tool/fs/globTool.js';
import { WorkspaceFileWalker } from '../../src/util/workspaceFileWalker.js';

/** 仓库根（测试固定从仓库根运行）。 */
const ROOT = process.cwd();
/** 工具上下文。 */
const ctx = (dir: string): { sessionId: string; workspaceRoot: string } => ({
  sessionId: 's1',
  workspaceRoot: dir,
});

test('① 真实仓库：递归列出 src 下 .ts 必须命中真实文件（修复前恒 0 命中）', async () => {
  const result = await new GlobTool(ROOT).handle(
    { id: 'c1', name: 'glob', arguments: { pattern: 'src/**/*.ts', max_results: 5 } },
    ctx(ROOT),
  );
  assert.strictEqual(
    result.ok,
    true,
    `真实仓库上 glob 不该失败：${result.error ?? ''}（截断+零命中已被判为 fail-loud）`,
  );
  assert.match(
    result.output ?? '',
    /src\/[a-z0-9]+\/[A-Za-z0-9]+\.ts/,
    `glob 应命中真实 .ts 文件，实际输出：${(result.output ?? '').slice(0, 200)}`,
  );
});

test('② 真实仓库：grep（path=src/cli）必须命中真实内容（修复前恒 0）', async () => {
  const result = await new GrepTool(ROOT).handle(
    {
      id: 'c2',
      name: 'grep',
      arguments: { pattern: 'KNOWN_EXTRA_FLAGS', path: 'src/cli', glob: '*.ts', max_results: 3 },
    },
    ctx(ROOT),
  );
  assert.strictEqual(result.ok, true, `真实仓库上 grep 不该失败：${result.error ?? ''}`);
  assert.match(
    result.output ?? '',
    /src\/cli\/[A-Za-z]+\.ts:\d+/,
    `grep 应命中 src/cli 下真实内容，实际输出：${(result.output ?? '').slice(0, 200)}`,
  );
});

test('③ 忽略清单含 harness 自己的缓存/资产目录（否则遍历预算会被资产吃满）', () => {
  for (const dir of ['third-party', '.cache', '.omniharness', 'node_modules', '.git']) {
    assert.ok(
      WorkspaceFileWalker.DEFAULT_IGNORED_DIRS.has(dir),
      `忽略清单缺 ${dir}：它属于二进制资产/缓存，会让 glob/grep 在真实仓库上恒 0 命中`,
    );
  }
});

test('④ 截断语义仍如实回报（maxFiles 触顶 ⇒ truncated=true）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omni-walk-trunc-'));
  try {
    const { writeFile } = await import('node:fs/promises');
    for (let i = 0; i < 5; i += 1) await writeFile(join(dir, `f${String(i)}.ts`), 'x\n', 'utf8');
    const walk = await new WorkspaceFileWalker(dir, { maxFiles: 2 }).list();
    assert.strictEqual(walk.truncated, true, '触顶必须回报截断');
    assert.ok(walk.files.length <= 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
