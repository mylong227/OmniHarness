/**
 * 压缩摘要并入交接便签判据（T3.4 注入点 · 2026-11-01 接线收口）。
 *
 * 背景：便签此前只有工具入口（模型写入），没有任何自动消费点——「重置后读回交接物」
 * 靠提示词引导模型主动 read，概率性。压缩（compact）是**确定性**的重置点：折叠段生成
 * 摘要时把 scratchpad 最新便签并进摘要，工作记忆跨压缩存活不靠模型自觉。
 * 本判据钉住：有便签 ⇒ 摘要含【交接便签】段；无便签 ⇒ 零开销（摘要原样）。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ContextCompactor } from '../../src/context/contextCompactor.ts';
import { FileScratchpad } from '../../src/adapters/memory/fileScratchpad.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelPort, ModelOutput } from '../../src/ports/model/model.ts';
import type { ModelMessage } from '../../src/ports/model/model.ts';

/** 固定摘要器替身：把折叠段原样回显（避免真模型）。 */
const echoModel: ModelPort = {
  name: 'echo',
  generate: async (req): Promise<ModelOutput> => ({
    text: req.messages
      .map((m) => String(m.content ?? ''))
      .join('|')
      .slice(0, 200),
  }),
};

/** 一条可折叠的旧消息。 */
const oldMessage = (text: string): ModelMessage => ({ role: 'user', content: text });

const makeCompactor = (scratchpad?: FileScratchpad): ContextCompactor =>
  new ContextCompactor(echoModel, {
    maxTokens: 40,
    keepRecent: 1,
    ...(scratchpad !== undefined ? { scratchpad } : {}),
  });

const workspace = (): { root: string; cleanup: () => void } => {
  const root = mkdtempSync(join(tmpdir(), 'omni-compact-handoff-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
};

test('① 有便签：折叠摘要含【交接便签】段（工作记忆跨压缩存活）', async () => {
  const { root, cleanup } = workspace();
  try {
    const scratchpad = new FileScratchpad(() => root);
    scratchpad.append('D1-① 已完成；下一步 D1-②；已确认：SQLite');
    const compactor = makeCompactor(scratchpad);
    const messages = [oldMessage('早期探索'.repeat(40)), oldMessage('最近消息')];
    const outcome = await compactor.compact(messages);
    const summary = outcome?.state?.summary ?? '';
    assert.ok(summary.includes('【交接便签】'), '压缩摘要必须并入交接便签段');
    assert.match(summary, /D1-②/u, '便签正文必须可读回');
  } finally {
    cleanup();
  }
});

test('② 无便签 / 未注入端口：摘要原样（零开销路径）', async () => {
  const { root, cleanup } = workspace();
  try {
    // 未注入端口。
    const bare = await makeCompactor(undefined).compact([
      oldMessage('早期探索'.repeat(40)),
      oldMessage('最近消息'),
    ]);
    assert.ok(bare?.state?.summary !== undefined);
    assert.ok(!bare.state.summary.includes('【交接便签】'), '未注入不得凭空出现便签段');
    // 注入了端口但暂无便签。
    const empty = await makeCompactor(new FileScratchpad(() => root)).compact([
      oldMessage('早期探索'.repeat(40)),
      oldMessage('最近消息'),
    ]);
    assert.ok(!(empty?.state?.summary ?? '').includes('【交接便签】'), '无便签零开销');
  } finally {
    cleanup();
  }
});
