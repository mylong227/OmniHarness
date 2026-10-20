/**
 * ACT-01：`browser_act` 默认引擎应为 Playwright（真 Chrome；无浏览器则跳过）。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { BrowserActTool } from '../../src/adapters/tool/browser/browserActTool.ts';
import { ChromeLocator } from '../../src/adapters/browser/chromeLocator.ts';
import { RequireEnv } from '../helpers/requireEnv.ts';
import type { ToolCall, ToolContext } from '../../src/ports/tool/tool.ts';

/** Playwright 是否真的可加载（optionalDependency，可能被 --omit=optional 跳过）。 */
const playwrightAvailable = ((): boolean => {
  try {
    createRequire(import.meta.url).resolve('playwright-core');
    return true;
  } catch {
    return false;
  }
})();

const available = ChromeLocator.locate().executable !== null && playwrightAvailable;

test(
  'ACT-01：browser_act 默认走 Playwright 并完成 click/ARIA',
  {
    skip: RequireEnv.skipUnlessBool(
      'OMNI_REQUIRE_BROWSER',
      available,
      '缺 Chrome 或 playwright-core',
    ),
  },
  async () => {
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
  },
);
