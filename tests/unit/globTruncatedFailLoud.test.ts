/**
 * `glob` 的**「截断 + 零命中 ⇒ fail-loud」**判据（2026-10-11）。
 *
 * ## 它拦的是什么
 *
 * 2026-10-06 真实 API 跑测实测：遍历在 `third-party/`（近 2 万文件）撞满上限、**根本没走到 `src/`** 时，
 * 旧行为仍返回 `ok:true` + "（无命中）"——模型据此断定"文件不存在"并开始瞎试（实测浪费 16 步）。
 * 现行为：`walk.truncated && matched.length === 0` ⇒ `ok:false` + 可行动的提示。
 *
 * ## 判据怎么构造（这就是给 `GlobTool` 加 `walkMaxFiles` 缝的理由）
 *
 * 该分支只在超大工作区可达 ⇒ 没缝就只能靠"真实仓库偶发命中"。有了缝，用「3 个文件的工作区 + 上限 1」
 * 即可**确定性**复现。三条判据：
 * ① 截断 + 零命中 ⇒ `ok:false`，且提示里必须出现"截断"与可行动建议（不是干巴巴的失败）；
 * ② **反面对照**：不截断的同一模式 ⇒ 仍 `ok:true`（零命中本身不是错误，别过度收紧）；
 * ③ 截断但**有命中** ⇒ 仍 `ok:true`（截断只让"0 命中"不可信，不影响"有命中"的结论）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GlobTool } from '../../src/adapters/tool/fs/globTool.js';
import type { ToolContext } from '../../src/ports/tool/tool.js';

/**
 * 造一个含 3 个 `.ts` 文件的小工作区。
 * @returns 工作区路径与清理函数。
 */
function makeWorkspace(): { readonly dir: string; readonly cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'omni-glob-trunc-'));
  mkdirSync(join(dir, 'a'), { recursive: true });
  for (const name of ['one.ts', 'two.ts', 'three.ts']) {
    writeFileSync(join(dir, 'a', name), '// x\n', 'utf8');
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 工具上下文：workspaceRoot 指向被测工作区。 */
function ctx(dir: string): ToolContext {
  return { sessionId: 's-glob', workspaceRoot: dir };
}

test('① 截断 + 零命中 ⇒ ok:false 且提示可行动（不再让模型以为"文件不存在"）', async () => {
  const { dir, cleanup } = makeWorkspace();
  try {
    // 上限 1 ⇒ 遍历必然截断；模式匹配不到任何文件 ⇒ 触发 fail-loud
    const result = await new GlobTool(dir, 1).handle(
      { id: 'c1', name: 'glob', arguments: { pattern: '**/*.nomatch' } },
      ctx(dir),
    );
    assert.strictEqual(result.ok, false, '截断 + 零命中必须是失败，而不是"（无命中）"的成功');
    const error = result.error ?? '';
    assert.match(error, /截断/, `提示必须点明"被上限截断"，实为：${error}`);
    assert.match(error, /0 命中不可信|不可信/, `提示必须点明结论不可信，实为：${error}`);
    assert.match(error, /list_dir|缩小/, `提示必须给出可行动的下一步，实为：${error}`);
  } finally {
    cleanup();
  }
});

test('② 反面对照：不截断时零命中仍走 ok:true（零命中本身不是错误）', async () => {
  const { dir, cleanup } = makeWorkspace();
  try {
    const result = await new GlobTool(dir).handle(
      { id: 'c2', name: 'glob', arguments: { pattern: '**/*.nomatch' } },
      ctx(dir),
    );
    assert.strictEqual(result.ok, true, `不截断的零命中不该失败：${result.error ?? ''}`);
    assert.match(result.output ?? '', /无命中/, '应如实报"（无命中）"');
  } finally {
    cleanup();
  }
});

test('③ 截断但**有**命中 ⇒ 仍 ok:true（截断只否定"0 命中"，不否定命中本身）', async () => {
  const { dir, cleanup } = makeWorkspace();
  try {
    const result = await new GlobTool(dir, 1).handle(
      { id: 'c3', name: 'glob', arguments: { pattern: '**/*.ts' } },
      ctx(dir),
    );
    assert.strictEqual(result.ok, true, `有命中就不该失败：${result.error ?? ''}`);
    assert.match(result.output ?? '', /one\.ts|two\.ts|three\.ts/, '命中结果里应出现真实文件');
  } finally {
    cleanup();
  }
});
