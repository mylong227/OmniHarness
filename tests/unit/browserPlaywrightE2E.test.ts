/**
 * ACT-01：Playwright 第二引擎真机 E2E（无 Chrome/未安装 playwright-core 则跳过）。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ChromeLocator } from '../../src/adapters/browser/chromeLocator.ts';
import { PlaywrightBrowserSession } from '../../src/adapters/browser/playwrightBrowserSession.ts';

test('ACT-01：Playwright 引擎 goto→click→aria_snapshot 读到 DOM 变化', async () => {
  if (ChromeLocator.locate().executable === null) return;
  try {
    await import('playwright-core');
  } catch {
    return;
  }
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      '<!doctype html><html><body>' +
        '<button id="b" onclick="document.getElementById(\'out\').textContent=\'clicked\'">go</button>' +
        '<div id="out">idle</div>' +
        '</body></html>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const session = new PlaywrightBrowserSession();
  try {
    const goto = await session.act({ kind: 'goto', url: `http://127.0.0.1:${String(port)}/` });
    assert.strictEqual(goto.ok, true, goto.output);
    const clicked = await session.act({ kind: 'click', selector: '#b' });
    assert.strictEqual(clicked.ok, true, clicked.output);
    const aria = await session.act({ kind: 'aria_snapshot' });
    assert.strictEqual(aria.ok, true, aria.output);
    assert.match(aria.output, /clicked/);
  } finally {
    await session.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
