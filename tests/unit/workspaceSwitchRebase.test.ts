/**
 * 「切换项目」早退判据（2026-10-07 用户报「打开文件报 ENOENT」暴露的根分离缺陷）。
 *
 * ## 缺陷形态（真机可复核）
 *
 * 用户会话 `sess_muxo8f8a_1`（workspace 标记 `D:\Download\work_001`）里，agent 的
 * `read_file AGENTS.md` **读回的是启动目录那棵树**的 AGENTS.md（`list_dir "."` 回的是 OmniHarness
 * 仓库根的文件清单），而同一次会话的 UI「打开」按**显示根**解析这同一个相对路径 ⇒
 * `读取失败: ENOENT ... D:\Download\work_001\AGENTS.md`（本机 RPC 复现：`fs.read {path:'AGENTS.md'}`
 * 当场回该 ENOENT）。
 *
 * 根因在「切换项目」的**早退分支**：它只比显示/持久化根（`configStore.workspace()`），而工具与系统
 * 提示用的是运行时根（`options.config.workspaceRoot`）。两者一旦分离（本仓反复出现的「显示 ≠ 实际
 * 运行根」家族），切换被判成「没变」⇒ **跳过重基** ⇒ 工具永远留在旧根上，症状伪装成「文件不存在」。
 *
 * ## 判据
 *
 * ① 判据函数真值表：**两份根都是目标根才算没变**（只看显示根的旧实现，在「显示=目标、运行时=旧根」
 *    这一格会误判为「没变」——这正是线上形态）；
 * ② 接线守卫：`switchWorkspace` 必须把运行时根传进判据（不得退回只比显示根）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppServerBase } from '../../src/server/core/appServerBase.js';

/** 仓库根（`dist/tests/unit` → 上溯三级）；源码级判据必须读**源码**而不是编译产物。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SOURCE = join(REPO_ROOT, 'src', 'server', 'core', 'appServerBase.ts');

describe('切换项目：早退判据必须同时看运行时根（否则跳过重基，工具留在旧树）', () => {
  it('只有「显示根 = 运行时根 = 目标根」才允许早退', () => {
    const target = 'D:\\Download\\work_001';
    assert.strictEqual(AppServerBase.isWorkspaceSwitchNoop(target, target, target), true);
  });

  it('线上形态：显示根已是目标根、运行时根还是旧根 ⇒ **不得**早退（旧实现正是在这里误判）', () => {
    assert.strictEqual(
      AppServerBase.isWorkspaceSwitchNoop(
        'D:\\Download\\work_001',
        'D:\\Download\\work_001',
        'D:\\deepseek\\omniharness',
      ),
      false,
    );
  });

  it('运行时根已是目标根、显示根还没跟上 ⇒ 同样不得早退（要同步显示层）', () => {
    assert.strictEqual(
      AppServerBase.isWorkspaceSwitchNoop(
        'D:\\Download\\work_001',
        'D:\\deepseek\\omniharness',
        'D:\\Download\\work_001',
      ),
      false,
    );
  });

  it('接线守卫：switchWorkspace 必须把 options.config.workspaceRoot 传进判据', () => {
    const src = readFileSync(SOURCE, 'utf8');
    assert.match(
      src,
      /isWorkspaceSwitchNoop\(root,\s*previous,\s*this\.options\.config\.workspaceRoot\)/,
      '早退判据必须带运行时根；退回「只比显示根」会让工具与提示留在旧工作区（线上 ENOENT 形态）',
    );
    assert.doesNotMatch(
      src,
      /if \(root === previous\) \{\s*return \{ ok: true, workspace: root, unchanged: true \}/,
      '旧写法（只比显示根就早退）不得复活',
    );
  });
});
