/** `browser_act` 的 Playwright→CDP 回退判据（2026-10-21）。 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { BrowserActTool } from '../../src/adapters/tool/browser/browserActTool.ts';
import type { BrowserSession } from '../../src/adapters/browser/browserSession.ts';
import type { BrowserActionPort } from '../../src/ports/tool/browserAction.ts';
import type { ToolCall, ToolContext } from '../../src/ports/tool/tool.ts';

const context: ToolContext = { sessionId: 's', workspaceRoot: process.cwd() };

function call(args: Record<string, unknown>): ToolCall {
  return { id: 'c1', name: 'browser_act', arguments: args };
}

test('ACT-01：Playwright 启动失败时 browser_act 自动回退 CDP，且后续直接走 CDP', async () => {
  let playwrightCalls = 0;
  let playwrightCloses = 0;
  let cdpCalls = 0;
  let cdpCloses = 0;
  const failingPlaywright: BrowserActionPort & { close(): Promise<void> } = {
    act: async () => {
      playwrightCalls += 1;
      throw new Error('playwright-core 未安装');
    },
    close: async () => {
      playwrightCloses += 1;
    },
  };
  const fakeCdp = {
    act: async () => {
      cdpCalls += 1;
      return { ok: true, output: 'CDP 已打开' };
    },
    close: async () => {
      cdpCloses += 1;
    },
  } as unknown as BrowserSession;
  const tool = new BrowserActTool({
    playwrightFactory: () => failingPlaywright,
    cdpFactory: () => fakeCdp,
  });
  try {
    const first = await tool.handle(call({ action: 'goto', url: 'http://127.0.0.1/' }), context);
    assert.strictEqual(first.ok, true, first.error);
    assert.strictEqual(playwrightCalls, 1);
    assert.strictEqual(cdpCalls, 1);

    const second = await tool.handle(call({ action: 'click', selector: '#b' }), context);
    assert.strictEqual(second.ok, true, second.error);
    assert.strictEqual(playwrightCalls, 1, '回退后不应再次尝试 Playwright');
    assert.strictEqual(cdpCalls, 2);
  } finally {
    await tool.close();
  }
  assert.strictEqual(playwrightCloses, 1);
  assert.strictEqual(cdpCloses, 1);
});

test('ACT-01：OMNI_BROWSER_ENGINE=cdp 直接走 CDP，不尝试 Playwright', async () => {
  const saved = process.env.OMNI_BROWSER_ENGINE;
  process.env.OMNI_BROWSER_ENGINE = 'cdp';
  let playwrightCalls = 0;
  let cdpCalls = 0;
  const fakeCdp = {
    act: async () => {
      cdpCalls += 1;
      return { ok: true, output: 'CDP' };
    },
    close: async () => {},
  } as unknown as BrowserSession;
  const tool = new BrowserActTool({
    playwrightFactory: () => {
      playwrightCalls += 1;
      throw new Error('不应走到 Playwright');
    },
    cdpFactory: () => fakeCdp,
  });
  try {
    const result = await tool.handle(call({ action: 'goto', url: 'http://127.0.0.1/' }), context);
    assert.strictEqual(result.ok, true, result.error);
    assert.strictEqual(playwrightCalls, 0);
    assert.strictEqual(cdpCalls, 1);
  } finally {
    await tool.close();
    if (saved === undefined) delete process.env.OMNI_BROWSER_ENGINE;
    else process.env.OMNI_BROWSER_ENGINE = saved;
  }
});

test('ACT-01：注入执行体（测试/显式引擎）时不回退', async () => {
  let cdpCalls = 0;
  const injected: BrowserActionPort = {
    act: async () => {
      throw new Error('显式引擎失败');
    },
  };
  const fakeCdp = {
    act: async () => {
      cdpCalls += 1;
      return { ok: true, output: '' };
    },
    close: async () => {},
  } as unknown as BrowserSession;
  const tool = new BrowserActTool({ session: injected, cdpFactory: () => fakeCdp });
  const result = await tool.handle(call({ action: 'goto', url: 'http://x/' }), context);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(cdpCalls, 0);
});
