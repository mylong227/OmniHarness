// 极简层（minimal.css）视觉验证：stub 页 + CDP 双主题截图。
// 用法：OMNI_CHROME_PATH=<chrome.exe> node web/test/minimalShots.mjs <输出目录>
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findBrowser, serveStatic, stubHtmlCdp, getFreePort,
  launchChromeForCdp, killChromeTree, waitForPageWs, CdpSession,
  WEB_ROOT_PATH,
} from './browserHarness.ts';

const outDir = process.argv[2] || join(tmpdir(), 'omni-minimal-shots');
mkdirSync(outDir, { recursive: true });

const browser = findBrowser();
if (!browser) {
  console.error('未找到浏览器，请设 OMNI_CHROME_PATH');
  process.exit(1);
}

const server = await serveStatic(WEB_ROOT_PATH, { '/_minimal-shots.html': stubHtmlCdp() });
const userDataDir = mkdtempSync(join(tmpdir(), 'omni-shots-ud-'));
let cdp, proc;
try {
  const port = await getFreePort();
  const url = `http://127.0.0.1:${server.port}/_minimal-shots.html`;
  proc = launchChromeForCdp(browser, url, userDataDir, port);
  const wsUrl = await waitForPageWs(port, '_minimal-shots.html');
  cdp = new CdpSession(wsUrl);
  const mounted = await cdp.waitMounted();
  if (!mounted) throw new Error('app 未挂载');

  // 填一点真实感内容：composer 输入 + 忙碌徽标
  await cdp.type('.composer-input textarea', '把 dist.old 清理掉，然后跑一遍全量门禁');

  for (const theme of ['dark', 'light']) {
    await cdp.evaluate(`document.documentElement.setAttribute('data-theme', '${theme}')`);
    await new Promise((r) => setTimeout(r, 120));
    const shot = join(outDir, `minimal-${theme}.png`);
    const len = await cdp.screenshot(shot);
    process.stdout.write(`${theme}: ${shot} (${len}B)\n`);
  }
} finally {
  if (cdp) cdp.close();
  killChromeTree(proc, userDataDir);
  await server.close();
}
