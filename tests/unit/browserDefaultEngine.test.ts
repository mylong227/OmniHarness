/**
 * ACT-01：`browser_act` 默认引擎应为 Playwright（真 Chrome；无浏览器则跳过）。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { BrowserActTool } from '../../src/adapters/tool/browser/browserActTool.ts';
import { ChromeLocator } from '../../src/adapters/browser/chromeLocator.ts';
import type { ToolCall, ToolContext } from '../../src/ports/tool/tool.ts';

test('ACT-01：browser_act 默认走 Playwright 并完成 click/ARIA', async () => {
  if (ChromeLocator.locate().executable === null) return;
  try {
    await import('playwright-core');
  } catch {
    return;
  }
  const tool = new BrowserActTool();
  const context: ToolContext = { sessionId: 's1', workspaceRoot: process.cwd() };
  const call = (args: Record<string, unknown>): ToolCall => ({
    id: 'c1',
    name: 'browser_act',
    arguments: args,
  });
  const page =
    '<!doctype html><html><body>' +
    '<button id="b" onclick="document.getElementById(\'out\').textContent=\'clicked\'">go</button>' +
    '<div id="out">idle</div></body></html>';
  try {
    const goto = await tool.handle(
      call({ action: 'goto', url: `data:text/html,${encodeURIComponent(page)}` }),
      context,
    );
    assert.strictEqual(goto.ok, true, goto.error);
    const click = await tool.handle(call({ action: 'click', selector: '#b' }), context);
    assert.strictEqual(click.ok, true, click.error);
    const aria = await tool.handle(call({ action: 'aria_snapshot' }), context);
    assert.strictEqual(aria.ok, true, aria.error);
    assert.match(aria.output ?? '', /clicked/);
  } finally {
    await tool.close();
  }
});
