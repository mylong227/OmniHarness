/**
 * 工作便签工具（`scratchpad`）判据（T3.4 · 2026-11-01 接线收口）。
 *
 * 被修的缺陷形态：便签存储（FileScratchpad）与配置接线全部就位，却没有任何模型可用的
 * 读写入口——「重置后读回交接物恢复任务」的功能链断在最后一米。本判据钉住三件事：
 *  ① write → read 闭环（含 tags 与条数上限夹取）；
 *  ② 参数 fail-closed（write 缺 text / action 非法即拒，不猜）；
 *  ③ clear 清空 + 空态可读（不抛错）。
 * 端口语义（fail-soft 写盘、有界保留）由 tests/unit/scratchpad.test.ts 钉住，此处不重复。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScratchpadTool } from '../../src/kernel/adapters/tool/memory/scratchpadTool.ts';
import { FileScratchpad } from '../../src/kernel/adapters/memory/fileScratchpad.ts';
import { MUTATING_TOOL_NAMES, TOOL_NAMES } from '../../src/contracts/ports/tool/toolNames.ts';

/** 每用例一个独立临时工作区（FileScratchpad 落盘 `<root>/.omniharness/scratchpad.json`）。 */
const makeTool = (): { tool: ScratchpadTool; cleanup: () => void } => {
  const root = mkdtempSync(join(tmpdir(), 'omni-scratchpad-tool-'));
  return {
    tool: new ScratchpadTool(new FileScratchpad(() => root)),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
};

test('① write → read 闭环：正文与 tags 原样回读；k 夹取到 [1,50]', async () => {
  const { tool, cleanup } = makeTool();
  try {
    const written = await tool.handle({
      id: 'c1',
      name: TOOL_NAMES.scratchpad,
      arguments: {
        action: 'write',
        text: 'D1-① 已完成，下一步 D1-②；已确认：存储用 SQLite',
        tags: ['D1', '决策'],
      },
    });
    assert.strictEqual(written.ok, true, 'write 应受理');
    const read = await tool.handle({
      id: 'c2',
      name: TOOL_NAMES.scratchpad,
      arguments: { action: 'read', k: 5 },
    });
    assert.strictEqual(read.ok, true);
    assert.match(String(read.output), /D1-① 已完成/u, '正文必须可回读');
    assert.match(String(read.output), /\[D1,决策\]/u, 'tags 必须回显');
    // k 夹取：0/负数 → 1；超大 → 50（不抛错）。
    for (const k of [0, -3, 999]) {
      const clamped = await tool.handle({
        id: `c-k${k}`,
        name: TOOL_NAMES.scratchpad,
        arguments: { action: 'read', k },
      });
      assert.strictEqual(clamped.ok, true, `k=${String(k)} 应被夹取而非报错`);
    }
  } finally {
    cleanup();
  }
});

test('② 参数 fail-closed：write 缺 text / action 非法即拒', async () => {
  const { tool, cleanup } = makeTool();
  try {
    const noText = await tool.handle({
      id: 'c1',
      name: TOOL_NAMES.scratchpad,
      arguments: { action: 'write' },
    });
    assert.strictEqual(noText.ok, false, 'write 缺 text 必须拒绝');
    const badAction = await tool.handle({
      id: 'c2',
      name: TOOL_NAMES.scratchpad,
      arguments: { action: 'wipe' },
    });
    assert.strictEqual(badAction.ok, false, '非法 action 必须拒绝');
  } finally {
    cleanup();
  }
});

test('③ clear 清空 + 空态可读；工具属写类（MUTATING，plan 模式 fail-closed 拦截）', async () => {
  const { tool, cleanup } = makeTool();
  try {
    await tool.handle({
      id: 'c1',
      name: TOOL_NAMES.scratchpad,
      arguments: { action: 'write', text: '旧任务交接' },
    });
    const cleared = await tool.handle({
      id: 'c2',
      name: TOOL_NAMES.scratchpad,
      arguments: { action: 'clear' },
    });
    assert.strictEqual(cleared.ok, true);
    const read = await tool.handle({
      id: 'c3',
      name: TOOL_NAMES.scratchpad,
      arguments: { action: 'read' },
    });
    assert.match(String(read.output), /暂无便签/u, '清空后读取给出空态说明');
    assert.ok(
      MUTATING_TOOL_NAMES.has(TOOL_NAMES.scratchpad),
      'write/clear 落盘工作区状态 ⇒ 必须按写类收口（plan 模式与调度器串行同源）',
    );
  } finally {
    cleanup();
  }
});
