// ClipboardCopier 单元判据（jsdom）。
//
// 2026-10-31 用户口径：复制必须**真实成功**——Clipboard API 被拒/缺席时降级
// execCommand 也要写进去；全败时如实返回 false，调用方不得假报成功。
//
// ⚠️ 本文件是 jsdom 环境：真机（真 Chrome）部分在 `copyFeedback.test.ts`（node 环境）。
// 不要把两类用例混进同一个文件——jsdom 环境会把全局 `WebSocket` 换成 jsdom 的残缺实现，
// CDP 真机会连不上（实测报 CDP WebSocket 已关闭，且 harness 的「typeof WebSocket ===
// 'function'」守卫挡不住这种假货）。
import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import { ClipboardCopier } from '../src/ui/models/ClipboardCopier.ts';

// @vitest-environment jsdom

afterEach(() => {
  // 每个用例拆掉测试注入的 clipboard / execCommand，避免串味。
  Reflect.deleteProperty(navigator, 'clipboard');
  Reflect.deleteProperty(document, 'execCommand');
});

test('① Clipboard API 可用：写入成功且不走降级', async () => {
  let writeTextCalled = 0;
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (t: string) => {
        writeTextCalled += 1;
        assert.strictEqual(t, '内容甲');
      },
    },
  });
  const ok = await ClipboardCopier.copy('内容甲');
  assert.strictEqual(ok, true, 'Clipboard API 成功必须返回 true');
  assert.strictEqual(writeTextCalled, 1);
});

test('② Clipboard API 被拒：降级 execCommand 仍要真实写入', async () => {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async () => Promise.reject(new Error('denied')) },
  });
  let execText = '';
  document.execCommand = ((cmd: string) => {
    assert.strictEqual(cmd, 'copy');
    execText = (document.querySelector('textarea[readonly]') as HTMLTextAreaElement | null)?.value ?? '';
    return true;
  }) as unknown as typeof document.execCommand;
  const ok = await ClipboardCopier.copy('内容乙');
  assert.strictEqual(ok, true, 'API 被拒时 execCommand 成功必须返回 true');
  assert.strictEqual(execText, '内容乙', '降级路径必须把**原文**放进选区再复制');
  assert.strictEqual(document.querySelector('textarea[readonly]'), null, '降级 textarea 必须清理干净');
});

test('③ 两条路径都失败：如实返回 false（调用方不得假报成功）', async () => {
  document.execCommand = (() => false) as unknown as typeof document.execCommand;
  const ok = await ClipboardCopier.copy('内容丙');
  assert.strictEqual(ok, false);
});
