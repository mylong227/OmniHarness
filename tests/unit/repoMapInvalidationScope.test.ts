/**
 * repo-map 失效范围的回归判据（2026-10-25）。
 *
 * 背景：`StepToolExecutor.maybeInvalidateRepoMap` 曾复用 `MUTATING_TOOLS`，把 `shell` /
 * `run_code` / 子代理都当成「立即知道改了哪些文件」，每次成功即触发全仓 `contentHashes()`
 * （本机 1.0–2.4 s/次）。`shell` 在真实回合里出现频率最高，20 次 shell 可白烧 24–48 s。
 *
 * 现在只有明确写文件的工具才硬失效；其余交给 `fs.watch` + TTL。本判据钉住三件事：
 *  1. 明确写文件的工具在集合内；
 *  2. `shell` / `run_code` 等「可能写但不可预知」的工具不在集合内；
 *  3. 安全口径 `MUTATING_TOOLS` 不被削弱（shell 仍在，plan/监督/串行屏障语义不变）。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { MUTATING_TOOLS, REPO_MAP_INVALIDATING_TOOLS } from '../../src/core/toolGate.ts';
import { TOOL_NAMES } from '../../src/ports/tool/toolNames.ts';

test('repo-map 硬失效集合只含明确写文件的工具', () => {
  for (const name of [
    TOOL_NAMES.writeFile,
    TOOL_NAMES.edit,
    TOOL_NAMES.applyPatch,
    TOOL_NAMES.patchCandidates,
    TOOL_NAMES.rollback,
  ]) {
    assert.ok(REPO_MAP_INVALIDATING_TOOLS.has(name), `${name} 必须立即复核 repo-map`);
  }
});

test('shell / run_code 等不可预知写盘的工具不触发全仓重哈希', () => {
  for (const name of [
    TOOL_NAMES.shell,
    TOOL_NAMES.shellInteractive,
    TOOL_NAMES.shellJob,
    TOOL_NAMES.runCode,
    TOOL_NAMES.delegate,
    TOOL_NAMES.subagent,
    TOOL_NAMES.runWorkflow,
  ]) {
    assert.ok(
      !REPO_MAP_INVALIDATING_TOOLS.has(name),
      `${name} 不应硬失效 repo-map（应交给 watcher/TTL）`,
    );
  }
});

test('安全口径不被削弱：硬失效集合是写类集合的子集，shell 仍在写类集合', () => {
  for (const name of REPO_MAP_INVALIDATING_TOOLS) {
    assert.ok(MUTATING_TOOLS.has(name), `${name} 必须仍属写类工具`);
  }
  assert.ok(MUTATING_TOOLS.has(TOOL_NAMES.shell), 'shell 仍须被 plan/监督/串行屏障视为写类');
});
