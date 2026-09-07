import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadProjectInstructions,
  loadProjectInstructionsCached,
  clearProjectInstructionsCache,
} from '../../src/context/projectInstructions.js';

let root: string;
let home: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'omni-instr-'));
  home = await mkdtemp(join(tmpdir(), 'omni-home-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
  clearProjectInstructionsCache();
});

describe('仓库常驻指令加载', () => {
  it('无任何指令文件时返回 null（调用方应跳过注入而非注入空串）', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'omni-empty-'));
    const result = await loadProjectInstructions({
      workspaceRoot: empty,
      home,
      cwd: empty,
    });
    assert.strictEqual(result, null);
    await rm(empty, { recursive: true, force: true });
  });

  it('加载项目级 AGENTS.md 与 CLAUDE.md 并记录来源', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omni-proj-'));
    await writeFile(join(dir, 'AGENTS.md'), '# 项目规则\n先写测试');
    await writeFile(join(dir, 'CLAUDE.md'), '# Claude 规则\n禁裸强转');

    const result = await loadProjectInstructions({
      workspaceRoot: dir,
      home,
      cwd: dir,
    });

    assert.notStrictEqual(result, null);
    assert.ok(result!.content.includes('先写测试'), '应包含 AGENTS.md 内容');
    assert.ok(result!.content.includes('禁裸强转'), '应包含 CLAUDE.md 内容');
    assert.ok(
      result!.sources.some((s) => s.endsWith('AGENTS.md')),
      'sources 应记录 AGENTS.md',
    );
    assert.strictEqual(result!.truncated, false);
    await rm(dir, { recursive: true, force: true });
  });

  it('AGENTS.override.md 存在时整体取代 AGENTS.md（override 语义，非合并）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omni-override-'));
    await writeFile(join(dir, 'AGENTS.md'), '原始规则');
    await writeFile(join(dir, 'AGENTS.override.md'), '覆盖规则');

    const result = await loadProjectInstructions({
      workspaceRoot: dir,
      home,
      cwd: dir,
    });

    assert.notStrictEqual(result, null);
    assert.ok(result!.content.includes('覆盖规则'));
    assert.ok(!result!.content.includes('原始规则'), 'AGENTS.md 应被整体取代');
    await rm(dir, { recursive: true, force: true });
  });

  it('子目录级指令被加载，且位于项目级之后（越靠近 cwd 越优先）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omni-sub-'));
    const sub = join(dir, 'packages', 'core');
    await mkdir(sub, { recursive: true });
    await writeFile(join(dir, 'AGENTS.md'), '根级规则');
    await writeFile(join(sub, 'AGENTS.md'), '子目录规则');

    const result = await loadProjectInstructions({
      workspaceRoot: dir,
      home,
      cwd: sub,
    });

    assert.notStrictEqual(result, null);
    const rootIdx = result!.content.indexOf('根级规则');
    const subIdx = result!.content.indexOf('子目录规则');
    assert.ok(rootIdx >= 0 && subIdx >= 0, '两级规则都应纳入');
    assert.ok(rootIdx < subIdx, '子目录级应排在后面（优先级更高）');
    await rm(dir, { recursive: true, force: true });
  });

  it('用户级指令被加载（~/.omniharness 与 ~/.claude）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omni-user-'));
    const userDir = await mkdtemp(join(tmpdir(), 'omni-userhome-'));
    await mkdir(join(userDir, '.omniharness'), { recursive: true });
    await writeFile(join(userDir, '.omniharness', 'AGENTS.md'), '用户级规则');

    const result = await loadProjectInstructions({
      workspaceRoot: dir,
      home: userDir,
      cwd: dir,
    });

    assert.notStrictEqual(result, null);
    assert.ok(result!.content.includes('用户级规则'));
    await rm(dir, { recursive: true, force: true });
    await rm(userDir, { recursive: true, force: true });
  });

  it('@import 展开被引用的文件', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omni-import-'));
    await writeFile(join(dir, 'shared.md'), '共享约定内容');
    await writeFile(join(dir, 'AGENTS.md'), '# 主规则\n@import ./shared.md');

    const result = await loadProjectInstructions({
      workspaceRoot: dir,
      home,
      cwd: dir,
    });

    assert.notStrictEqual(result, null);
    assert.ok(result!.content.includes('共享约定内容'), '@import 应被展开');
    await rm(dir, { recursive: true, force: true });
  });

  it('@import 越界引用被跳过且不抛出（路径穿越防护）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omni-escape-'));
    await writeFile(join(dir, 'AGENTS.md'), '@import ../../../../etc/passwd');

    const result = await loadProjectInstructions({
      workspaceRoot: dir,
      home,
      cwd: dir,
    });

    assert.notStrictEqual(result, null);
    assert.ok(result!.content.includes('已忽略越界引用'), '应留下可审计的忽略标记');
    assert.ok(!result!.content.includes('root:'), '绝不能读入工作区外内容');
    await rm(dir, { recursive: true, force: true });
  });

  it('超出容量上限时截断并标记 truncated', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omni-limit-'));
    await writeFile(join(dir, 'AGENTS.md'), 'A'.repeat(1000));
    await writeFile(join(dir, 'CLAUDE.md'), 'B'.repeat(1000));

    const result = await loadProjectInstructions({
      workspaceRoot: dir,
      home,
      cwd: dir,
      maxBytes: 1200,
    });

    assert.notStrictEqual(result, null);
    assert.strictEqual(result!.truncated, true);
    assert.ok(!result!.content.includes('BBB'), '超限文件应被丢弃');
    await rm(dir, { recursive: true, force: true });
  });

  it('llms.txt 作为独立段落纳入，可用 includeLlmsTxt=false 关闭', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omni-llms-'));
    await writeFile(join(dir, 'llms.txt'), '# 文档索引\n- 指南: /docs');

    const on = await loadProjectInstructions({ workspaceRoot: dir, home, cwd: dir });
    const off = await loadProjectInstructions({
      workspaceRoot: dir,
      home,
      cwd: dir,
      includeLlmsTxt: false,
    });

    assert.notStrictEqual(on, null);
    assert.ok(on!.content.includes('文档索引'));
    assert.ok(on!.sources.some((s) => s.endsWith('llms.txt')));
    assert.strictEqual(off, null, '关闭后不应纳入 llms.txt');
    await rm(dir, { recursive: true, force: true });
  });

  it('读取器抛错时 fail-closed 跳过，不阻断主流程', async () => {
    const result = await loadProjectInstructions({
      workspaceRoot: root,
      home,
      cwd: root,
      read: async () => {
        throw new Error('EACCES');
      },
    });
    assert.strictEqual(result, null);
  });

  it('缓存版本在 TTL 内返回同一结果，清缓存后重新读盘', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omni-cache-'));
    await writeFile(join(dir, 'AGENTS.md'), '第一版');

    const first = await loadProjectInstructionsCached(
      { workspaceRoot: dir, home, cwd: dir },
      60_000,
    );
    assert.ok(first!.content.includes('第一版'));

    await writeFile(join(dir, 'AGENTS.md'), '第二版');
    const cached = await loadProjectInstructionsCached(
      { workspaceRoot: dir, home, cwd: dir },
      60_000,
    );
    assert.ok(cached!.content.includes('第一版'), 'TTL 内应命中缓存');

    clearProjectInstructionsCache();
    const fresh = await loadProjectInstructionsCached(
      { workspaceRoot: dir, home, cwd: dir },
      60_000,
    );
    assert.ok(fresh!.content.includes('第二版'), '清缓存后应重读');
    clearProjectInstructionsCache();
    await rm(dir, { recursive: true, force: true });
  });

  it('指令内容携带来源标记，便于模型与审计区分出处', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omni-mark-'));
    await writeFile(join(dir, 'AGENTS.md'), '规则正文');

    const result = await loadProjectInstructions({
      workspaceRoot: dir,
      home,
      cwd: dir,
    });

    assert.ok(result!.content.includes('<!-- 常驻指令:'), '应带来源注释');
    await rm(dir, { recursive: true, force: true });
  });
});
