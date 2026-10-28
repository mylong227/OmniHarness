// 关键交互态补拍（W0 基线；W5 复核复用）：**一态一页**——每个状态起独立 Chrome 实例。
//
// 为什么不进 visualProbe 的多态循环：W0 实测单页连续跑 20+ 态后页面退化（chip 选择器消失 /
// 重载不挂载），而同一序列在独立页面里 100% 复现（debugSeedState 实测）。单页多态是探针的
// 结构性问题，不在本批修；这里用「每态新起页面」绕开，代价是每态 ~3s 启动，14 张可接受。
// 选择器配方与 visualProbe 的 STATES 逐字同源——两边将来要一起改（W5 收口时并入探针）。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findBrowser,
  serveStatic,
  getFreePort,
  launchChromeForCdp,
  killChromeTree,
  waitForPageWs,
  CdpSession,
  stubHtmlCdp,
  WEB_ROOT_PATH,
} from './browserHarness.ts';

const ARCHIVE = join(WEB_ROOT_PATH, 'archive');
const WIDTH = 1280;
const HEIGHT = 900;

/** 一次截图的产出。 */
interface ShotOutcome {
  key: string;
  theme: string;
  ok: boolean;
  error?: string;
}

/** 把页面推进到「有会话 + 已收尾回合」的渲染态（与 visualProbe.seedSession 同源）。 */
async function seed(cdp: CdpSession): Promise<void> {
  await cdp.evaluate(
    "(function(){ var ta=document.querySelector('.composer-input textarea'); var b=document.querySelector('button.send'); if(ta&&b){ ta.value='打磨工作台视觉层'; b.dispatchEvent(new Event('input',{bubbles:true})); b.click(); } })()",
  );
  await cdp.waitFor('!!window.__RESOLVE_TURN__', 800);
  await cdp.evaluate(
    "window.__RESOLVE_TURN__ && window.__RESOLVE_TURN__({ threadId:'probe-t1', finalText:'', steps:1 });",
  );
  await new Promise((r) => setTimeout(r, 200));
}

/** 各交互态的打开配方（选择器与 visualProbe.STATES 同源）。 */
const OPENERS: Record<string, (cdp: CdpSession) => Promise<boolean>> = {
  dropdown: async (cdp) => {
    await cdp.click('.dd');
    return cdp.evaluate("!!document.querySelector('.dd-menu')");
  },
  modelpicker: async (cdp) => {
    await cdp.click('.mp');
    return cdp.evaluate("!!document.querySelector('.mp-menu')");
  },
  addmenu: async (cdp) => {
    await cdp.click('.addmenu-ico');
    return cdp.evaluate("!!document.querySelector('.addmenu-pop')");
  },
  capacity: async (cdp) => {
    await cdp.click('.cap');
    return cdp.evaluate("!!document.querySelector('.cap-pop')");
  },
  permission: async (cdp) => {
    await cdp.click('.dd.perm');
    return cdp.evaluate("!!document.querySelector('.dd-menu.wide')");
  },
  streaming: async (cdp) => {
    await cdp.push({ method: 'thread.text_delta', params: { text: '正在把增量' } });
    await cdp.push({ method: 'thread.text_delta', params: { text: '逐段拼进流式卡片……' } });
    const shown = await cdp.waitFor("!!document.querySelector('.streaming-assistant .content')", 600);
    await cdp.evaluate(
      "window.__RESOLVE_TURN__ && window.__RESOLVE_TURN__({ threadId:'probe-t1', finalText:'', steps:1 });",
    );
    return shown;
  },
  approval: async (cdp) => {
    await cdp.push({
      method: 'approval.request',
      params: {
        requestId: 'probe-r1',
        toolName: 'shell',
        target: 'rm -rf ./build',
        args: { cmd: 'rm -rf ./build' },
      },
    });
    return cdp.waitFor("!!document.querySelector('.overlay.show .modal[role=\"dialog\"]')", 400);
  },
};

async function captureOne(
  browser: string,
  server: { port: number; close: () => Promise<void> },
  key: string,
  theme: 'dark' | 'light',
  stamp: number,
): Promise<ShotOutcome> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'omni-keyshot-ud-'));
  const debugPort = await getFreePort();
  let cdp: CdpSession | undefined;
  let proc: ReturnType<typeof launchChromeForCdp> | undefined;
  try {
    proc = launchChromeForCdp(
      browser,
      `http://127.0.0.1:${server.port}/_keyshot-stub.html?theme=${theme}`,
      userDataDir,
      debugPort,
    );
    const wsUrl = await waitForPageWs(debugPort, '_keyshot-stub.html', 20000);
    cdp = new CdpSession(wsUrl);
    await cdp.startDiagnostics();
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: 1,
      mobile: false,
    });
    if (!(await cdp.waitMounted(8000))) return { key, theme, ok: false, error: '未挂载' };
    await cdp.evaluate(`document.documentElement.setAttribute('data-theme','${theme}')`);
    await seed(cdp);
    if (key === 'streaming') {
      // 流式态的回合必须保持在飞：seed 已收尾，这里重开一回合供增量落进流式卡片。
      await cdp.evaluate(
        "(function(){ var ta=document.querySelector('.composer-input textarea'); var b=document.querySelector('button.send'); if(ta&&b){ ta.value='第二回合'; b.dispatchEvent(new Event('input',{bubbles:true})); b.click(); } })()",
      );
      await cdp.waitFor('!!window.__RESOLVE_TURN__', 800);
    }
    const opened = await OPENERS[key]?.(cdp);
    if (opened !== true) return { key, theme, ok: false, error: '未能进入该状态' };
    await new Promise((r) => setTimeout(r, 250));
    const crash = await cdp.evaluate(
      "!!document.querySelector('.crash-panel') ? (document.querySelector('.crash-msg')||{}).textContent : ''",
    );
    if (crash) return { key, theme, ok: false, error: `渲染崩溃 → ${String(crash).slice(0, 100)}` };
    await cdp.screenshot(join(ARCHIVE, `polish-${theme}-state-${key}-${stamp}.png`));
    return { key, theme, ok: true };
  } catch (err) {
    return { key, theme, ok: false, error: String((err as Error)?.message ?? err).slice(0, 140) };
  } finally {
    if (cdp) cdp.close();
    if (proc) killChromeTree(proc, userDataDir);
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* 清扫器兜底 */
    }
  }
}

const browser = findBrowser();
if (!browser) {
  process.stdout.write('SKIP: 未找到浏览器\n');
  process.exit(0);
}
const server = await serveStatic(WEB_ROOT_PATH, { '/_keyshot-stub.html': stubHtmlCdp() });
const stamp = Date.now();
const outcomes: ShotOutcome[] = [];
for (const theme of ['dark', 'light'] as const) {
  for (const key of Object.keys(OPENERS)) {
    outcomes.push(await captureOne(browser, server, key, theme, stamp));
  }
}
await server.close();
const bad = outcomes.filter((o) => !o.ok);
process.stdout.write(
  JSON.stringify({ kind: 'key-state-shots', ok: outcomes.length - bad.length, failed: bad, stamp }) + '\n',
);
process.exit(0);
