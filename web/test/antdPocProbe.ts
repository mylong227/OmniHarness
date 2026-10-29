// W0 PoC 真机探针：双主题渲染 PoC 页 → 截图 + 运行时验证（antd v6 CSS 变量模式 / 皮肤接线）。
//
// 验证三件事（UI_LIBRARY_UPGRADE §7 W0 退出判据的"可读 + 接线"部分）：
//   ① --ant-* CSS 变量确实注入 documentElement（v6 默认 cssVar 的运行时证据）；
//   ② .ant-btn-primary 的实底色 === palette 的 --accent（"Ant 骨架 + 纸与墨皮肤"接上了线）；
//   ③ 双主题各截一张（web/archive/antd-poc-*.png），供密度/观感人工复核。
//
// 探针而非门禁：失败打印 JSON 并 exit 0（同 visualProbe 口径）。
// 用法：node --experimental-strip-types web/test/antdPocProbe.ts [--width=1280]

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
  WEB_ROOT_PATH,
} from './browserHarness.ts';

const ARCHIVE = join(WEB_ROOT_PATH, 'archive');
const PAGE = '/dist-poc/poc/antd.html';
const WIDTH = Number(process.argv.find((a) => a.startsWith('--width='))?.slice(8) ?? 1280);

function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

interface Verdict {
  varsInjected: boolean;
  primaryColorToken: string;
  primaryBtnBg: string;
  accent: string;
  primaryMatchesAccent: boolean;
  screenshots: string[];
}

/** 各主题的期望 accent（palette.ts 的 seed；dark 与 light 不同值）。 */
const EXPECTED_ACCENT: Record<'dark' | 'light', string> = {
  dark: '#a8b4e8',
  light: '#3d4a86',
};

async function probeOne(cdp: CdpSession, theme: 'dark' | 'light', stamp: number, httpPort: number): Promise<string> {
  // 固定视口：截图可复现（宽度可 --width= 覆盖，高度同 visualProbe 的 900）。
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.navigate(`http://127.0.0.1:${httpPort}${PAGE}?theme=${theme}`);
  // 等 antd 按钮渲染出来（vendor chunk 加载 + CSS-in-JS 注入）。
  const shown = await cdp.waitFor("!!document.querySelector('.ant-btn-primary')", 4000);
  if (!shown) throw new Error(`${theme}: PoC 页未渲染出 .ant-btn-primary`);
  await new Promise((r) => setTimeout(r, 300));
  const path = join(ARCHIVE, `antd-poc-${theme}-${stamp}.png`);
  await cdp.screenshot(path);
  return path;
}

const browser = findBrowser();
if (!browser) {
  emit({ kind: 'antd-poc', error: '未找到浏览器（OMNI_CHROME_PATH 可指定）', screenshots: [] });
  process.exit(0);
}
const server = await serveStatic(WEB_ROOT_PATH, {});
const userDataDir = mkdtempSync(join(tmpdir(), 'omni-poc-ud-'));
// 注意两个端口各司其职：httpPort = 静态服务（页面 URL 用它）；debugPort = Chrome CDP（launch 用它）。
// 混用会让页面打到「空闲探测端口」上——那个端口通常没人听或被别的进程占着（W0 实测即 404 假象）。
const debugPort = await getFreePort();
const httpPort = server.port;
const stamp = Date.now();
let proc: ReturnType<typeof launchChromeForCdp> | undefined;
let cdp: CdpSession | undefined;
try {
  proc = launchChromeForCdp(browser, `http://127.0.0.1:${httpPort}${PAGE}?theme=dark`, userDataDir, debugPort);
  const wsUrl = await waitForPageWs(debugPort, "antd.html", 15000);
  cdp = new CdpSession(wsUrl);
  await cdp.startDiagnostics();

  const shots: string[] = [];
  const verdicts: Record<string, Verdict> = {};
  for (const theme of ['dark', 'light'] as const) {
    shots.push(await probeOne(cdp, theme, stamp, httpPort));
    await cdp.navigate(`http://127.0.0.1:${httpPort}${PAGE}?theme=${theme}`);
    await cdp.waitFor("!!document.querySelector('.ant-btn-primary')", 4000);
    await new Promise((r) => setTimeout(r, 300));
    const accent = EXPECTED_ACCENT[theme];
    const v = (await cdp.evaluate(
      `(function(){
        // v6 的 cssVar 作用域挂在 antd App 包裹层（.ant-app.css-var-*），不在 :root——
        // W0 实测：381 个 --ant-* 变量在该节点上，子树经继承消费。
        var scope = document.querySelector('.ant-app') || document.documentElement;
        var cs = getComputedStyle(scope);
        var token = cs.getPropertyValue('--ant-color-primary').trim();
        var btn = document.querySelector('.ant-btn-primary');
        var bg = btn ? getComputedStyle(btn).backgroundColor : '';
        function toRgb(s){ var m = s.match(/\\d+/g); return m ? m.slice(0,3).map(Number) : null; }
        function hex(s){ var m = s.match(/^#([0-9a-f]{6})$/i); return m ? [parseInt(m[1].slice(0,2),16), parseInt(m[1].slice(2,4),16), parseInt(m[1].slice(4,6),16)] : null; }
        var a = hex('${accent}'); var b = toRgb(bg);
        var eq = !!a && !!b && a[0]===b[0] && a[1]===b[1] && a[2]===b[2];
        return { varsInjected: token !== '', primaryColorToken: token, primaryBtnBg: bg, accent: '${accent}', primaryMatchesAccent: eq };
      })()`,
    )) as Verdict;
    verdicts[theme] = v;
  }
  emit({ kind: 'antd-poc', verdicts, screenshots: shots, failures: [] });
} catch (err) {
  // 失败必须带出诊断（否则"没渲染"无从排查：JS 异常 / 404 / MIME 错都各自有指纹）。
  const diag = cdp
    ? cdp.diagnostics()
    : { console: [], exceptions: [], failedRequests: [], responses: [] };
  emit({
    kind: 'antd-poc',
    error: String((err as Error)?.message ?? err),
    diag,
    screenshots: [],
  });
} finally {
  if (cdp) cdp.close();
  if (proc) killChromeTree(proc, userDataDir);
  try {
    rmSync(userDataDir, { recursive: true, force: true });
  } catch {
    /* 清扫器兜底 */
  }
  await server.close();
}
