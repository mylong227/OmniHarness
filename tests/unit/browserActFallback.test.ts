/** `browser_act` 的 Playwright→CDP 回退判据（2026-10-21）。 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { BrowserActTool } from '../../src/kernel/adapters/tool/browser/browserActTool.ts';
import type { BrowserSession } from '../../src/kernel/adapters/browser/browserSession.ts';
import type { BrowserActionPort } from '../../src/contracts/ports/tool/browserAction.ts';
import type { ToolCall, ToolContext } from '../../src/contracts/ports/tool/tool.ts';

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

test('ACT-01：close 后仍可复用，且再次 close 关闭新会话（2026-10-21 泄漏修复）', async () => {
  let created = 0;
  let closed = 0;
  const makeSession = (): BrowserActionPort & { close(): Promise<void> } => {
    created += 1;
    return {
      act: async () => ({ ok: true, output: `session-${String(created)}` }),
      close: async () => {
        closed += 1;
      },
    };
  };
  const tool = new BrowserActTool({ playwrightFactory: makeSession });
  const first = await tool.handle(call({ action: 'goto', url: 'http://127.0.0.1/' }), context);
  assert.strictEqual(first.ok, true, first.error);
  assert.strictEqual(created, 1);
  await tool.close();
  assert.strictEqual(closed, 1);

  const second = await tool.handle(call({ action: 'goto', url: 'http://127.0.0.1/' }), context);
  assert.strictEqual(second.ok, true, second.error);
  assert.strictEqual(created, 2, 'close 后再次动作必须重新懒建会话');
  await tool.close();
  assert.strictEqual(closed, 2, '第二次 close 必须真的关闭新会话（此前因 closed 早退而泄漏）');
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

test('ACT-01：limits.browser.idleCloseMs 真的驱动空闲自动关闭（默认 3 分钟不会在这个时窗触发）', async () => {
  let closes = 0;
  const port: BrowserActionPort & { close(): Promise<void> } = {
    act: async () => ({ ok: true, output: 'ok' }),
    close: async () => {
      closes += 1;
    },
  };
  const tool = new BrowserActTool({
    playwrightFactory: () => port,
    limits: {
      actionTimeoutMs: 10,
      loadTimeoutMs: 10,
      commandTimeoutMs: 10,
      connectTimeoutMs: 10,
      launchTimeoutMs: 10,
      probeTimeoutMs: 10,
      idleCloseMs: 5,
    },
  });
  const result = await tool.handle(call({ action: 'goto', url: 'http://x/' }), context);
  assert.strictEqual(result.ok, true, result.error);
  assert.strictEqual(closes, 0, '动作刚结束不应立即关闭');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.strictEqual(closes, 1, 'limits.browser.idleCloseMs=5 应在 60ms 内关掉空闲会话');
});
