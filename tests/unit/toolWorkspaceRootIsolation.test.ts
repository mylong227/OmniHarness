/**
 * fs 工具族必须**统一按运行时 `ToolContext.workspaceRoot` 解析根**（2026-10-06 第六十一轮真实模型跑测暴露）。
 *
 * ## 它锁的是什么（一连串真实后果，逐条可查事件流）
 *
 * 子智能体跑在**隔离工作树**里（`ToolContext.workspaceRoot` 即那棵树），但 fs 工具曾各用各的根：
 * `read_file`/`glob`/`grep`/`shell` 用运行时 ctx，而 `write_file`/`edit`/`list_dir`/`apply_patch`
 * （以及 `view_image`/`view_media`/`browser_screenshot`/`sketch_write`）用**装配期根**。真机后果：
 *
 * 1. 子智能体 `write_file src/parse.mjs` 报「已写入」——**实际写进主工作区**（隔离对写类工具失效）；
 * 2. 它随后用 `shell` 跑自测（cwd = 隔离树）**看不到刚写的文件**，反复失败；
 * 3. 子代理耗尽步数预算收尾（`⚠️ 未完成：达步数上限`）；
 * 4. 改动采集在隔离树里只看到子会话存储文件 ⇒ 回执**谎报**「主工作区尚未改动」（其实已被改）。
 *
 * | # | 判据 |
 * | --- | --- |
 * | ① | `write_file` / `edit` / `apply_patch` / `list_dir` 在 ctx 指向另一棵树时，**只**改/读那棵树 |
 * | ② | `read_file` / `glob` / `grep` 保持 ctx 优先（不许在统一过程中被改回装配根） |
 * | ③ | ctx 根为空串时回落装配期根（不是崩、不是拒绝一切） |
 * | ④ | 子代理改动采集必须**排除运行期目录**（`.omni-storage/` 等）——否则 patch 变成会话日志 |
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WriteFileTool } from '../../src/adapters/tool/fs/writeFileTool.js';
import { EditFileTool } from '../../src/adapters/tool/fs/editFileTool.js';
import { ListDirTool } from '../../src/adapters/tool/fs/listDirTool.js';
import { ApplyPatchTool } from '../../src/adapters/tool/fs/applyPatchTool.js';
import { ReadFileTool } from '../../src/adapters/tool/fs/readFileTool.js';
import { GlobTool } from '../../src/adapters/tool/fs/globTool.js';
import { GrepTool } from '../../src/adapters/tool/fs/grepTool.js';
import { ToolWorkspaceRoot } from '../../src/util/toolWorkspaceRoot.js';
import { WorktreeOps } from '../../src/subagent/worktreeOps.js';

/** 建一个临时目录（调用方负责删）。 */
const tempDir = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));

/** 工具上下文：ctx 根 = 隔离树（与装配根故意不同）。 */
const ctxOf = (root: string): { sessionId: string; workspaceRoot: string } => ({
  sessionId: 's1',
  workspaceRoot: root,
});

test('① 写类/列目录工具只动运行时 ctx 那棵树（装配根一个字节都不变）', async () => {
  const assemblyRoot = tempDir('omni-root-assembly-');
  const isolatedRoot = tempDir('omni-root-isolated-');
  try {
    const write = new WriteFileTool(assemblyRoot);
    const written = await write.handle(
      {
        id: 'c1',
        name: 'write_file',
        arguments: { path: 'src/parse.mjs', content: 'export const a=1;\n' },
      },
      ctxOf(isolatedRoot),
    );
    assert.strictEqual(written.ok, true, `写应当成功：${written.error ?? ''}`);
    assert.ok(existsSync(join(isolatedRoot, 'src/parse.mjs')), '文件必须落在隔离树里');
    assert.ok(
      !existsSync(join(assemblyRoot, 'src/parse.mjs')),
      '隔离失效：文件落进了装配根（主工作区）——这正是子智能体实测踩到的那个故障',
    );

    const editor = new EditFileTool(assemblyRoot);
    const edited = await editor.handle(
      {
        id: 'c2',
        name: 'edit',
        arguments: { path: 'src/parse.mjs', old_string: 'a=1', new_string: 'a=2' },
      },
      ctxOf(isolatedRoot),
    );
    assert.strictEqual(edited.ok, true, `编辑应当命中隔离树里的文件：${edited.error ?? ''}`);

    const patch = new ApplyPatchTool(assemblyRoot);
    const patched = await patch.handle(
      {
        id: 'c3',
        name: 'apply_patch',
        arguments: {
          patch:
            '--- a/src/parse.mjs\n+++ b/src/parse.mjs\n@@ -1 +1 @@\n-export const a=2;\n+export const a=3;\n',
        },
      },
      ctxOf(isolatedRoot),
    );
    assert.strictEqual(patched.ok, true, `补丁应当落到隔离树：${patched.error ?? ''}`);
    assert.match(
      readFileSync(join(isolatedRoot, 'src', 'parse.mjs'), 'utf8'),
      /a=3/,
      '补丁必须作用在隔离树的那份文件上',
    );
    assert.ok(!existsSync(join(assemblyRoot, 'src')), '装配根不该出现任何文件');

    const list = new ListDirTool(assemblyRoot);
    const listed = await list.handle(
      { id: 'c4', name: 'list_dir', arguments: { path: 'src' } },
      ctxOf(isolatedRoot),
    );
    assert.strictEqual(listed.ok, true, `列目录应当列隔离树：${listed.error ?? ''}`);
    assert.match(listed.output ?? '', /parse\.mjs/, '应当看到隔离树里的文件');
  } finally {
    rmSync(assemblyRoot, { recursive: true, force: true });
    rmSync(isolatedRoot, { recursive: true, force: true });
  }
});

test('② 读类工具保持 ctx 优先（统一过程中不许把它们改回装配根）', async () => {
  const assemblyRoot = tempDir('omni-root-assembly2-');
  const isolatedRoot = tempDir('omni-root-isolated2-');
  try {
    mkdirSync(join(isolatedRoot, 'src'), { recursive: true });
    writeFileSync(join(isolatedRoot, 'src', 'only-in-isolated.ts'), 'export const MARK = 1;\n');
    const read = await new ReadFileTool().handle(
      { id: 'c1', name: 'read_file', arguments: { path: 'src/only-in-isolated.ts' } },
      ctxOf(isolatedRoot),
    );
    assert.strictEqual(read.ok, true, 'read_file 必须读 ctx 根');
    const globbed = await new GlobTool(assemblyRoot).handle(
      { id: 'c2', name: 'glob', arguments: { pattern: 'src/**/*.ts' } },
      ctxOf(isolatedRoot),
    );
    assert.strictEqual(globbed.ok, true, `glob 必须搜 ctx 根：${globbed.error ?? ''}`);
    assert.match(globbed.output ?? '', /only-in-isolated\.ts/);
    const grepped = await new GrepTool(assemblyRoot).handle(
      { id: 'c3', name: 'grep', arguments: { pattern: 'MARK', glob: '*.ts' } },
      ctxOf(isolatedRoot),
    );
    assert.strictEqual(grepped.ok, true, `grep 必须搜 ctx 根：${grepped.error ?? ''}`);
    assert.match(grepped.output ?? '', /MARK/);
  } finally {
    rmSync(assemblyRoot, { recursive: true, force: true });
    rmSync(isolatedRoot, { recursive: true, force: true });
  }
});

test('③ ctx 根为空串时回落装配期根', () => {
  assert.strictEqual(ToolWorkspaceRoot.of('/assembly', { workspaceRoot: '' }), '/assembly');
  assert.strictEqual(ToolWorkspaceRoot.of('/assembly', {}), '/assembly');
  assert.strictEqual(
    ToolWorkspaceRoot.of('/assembly', { workspaceRoot: '/isolated' }),
    '/isolated',
  );
});

test('④ 子代理改动采集排除运行期目录（否则 patch 变成会话日志）', async () => {
  const repo = tempDir('omni-wt-collect-');
  try {
    const git = (args: string[]): void => {
      execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    };
    git(['init', '-q']);
    git([
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'base',
    ]);
    // 子代理典型形态：写源码（业务改动）＋ 子会话自己的存储（运行期噪声，且**不在** .gitignore 里）。
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(join(repo, '.omni-storage'), { recursive: true });
    writeFileSync(join(repo, 'src', 'parse.mjs'), 'export const a = 1;\n');
    writeFileSync(join(repo, '.omni-storage', 'sess_x.jsonl'), '{"type":"user"}\n');

    const changes = await WorktreeOps.collectChanges(repo);
    assert.deepStrictEqual(
      [...changes.files].sort(),
      ['src/parse.mjs'],
      `改动清单必须只含业务改动，实际：${changes.files.join('、')}`,
    );
    assert.match(changes.patch, /src\/parse\.mjs/, 'patch 必须含源码改动');
    assert.ok(
      !changes.patch.includes('.omni-storage'),
      'patch 不得含子会话存储（实测它会把 patch 变成几十 KB 的会话日志）',
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
