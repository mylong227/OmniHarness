// 右栏「网页」面板 iframe 显示不全的判据（真机）。
//
// ## 用户报障（2026-10-31 截图）
//
// 右栏「网页」标签打开 pelican-bike.html（满屏 SVG 动画页），页面只在顶部渲染出约 150px 的
// 一条，下面整块空白——正是 iframe 的浏览器默认高度（replaced element 兜底 150px）。
//
// ## 根因（2026-10-31 探针实测：iframe 150 / tabpane 956）
//
// W2 把右栏标签条迁到 antd `Tabs`（v6）后，网页面板 `.web-pane` 成为 tabpane
// （`.ant-tabs-tabpane`）的**直接子元素**，而 tabpane 是普通 block 容器（非 flex）——
// `.web-pane` 上的 `flex: 1` 因此**失效**，取内容固有高；`.web-frame` 的 `flex: 1` 同理
// 无空间可分，回落到 replaced element 的默认 150px。文件面板 `.rv-pane` 不踩这个坑，
// 因为它显式写了 `height: 100%`（minimal.css 高度链，2026-10-31 修代码查看器时已探针实测）。
//
// ## 判据
//
// A. 意义守卫：tabpane 高度必须正常（> 400px）——tabpane 的高度链归 2026-10-31 那轮修复管，
//    它若塌了本判据测的是别的问题；
// B. iframe 必须填满地址栏以下的全部剩余高度（`frameRect.bottom` 贴住 paneRect.bottom），
//    高度 ≥ tabpane 高 − 地址栏高 − 容差；
// C. **正对照**：把修复撤掉（`.web-pane` 恢复无高度约束），判据必须变红——否则判据恒真。
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { openStubSession, stubHtmlCdp, type CdpSession } from './browserHarness.ts';

/** 与用户截图同档的桌面视口。 */
const VIEWPORT = { width: 1600, height: 1000 };

/** 桩页要带文件树与一份代码文件——tabCount=0 时 antd Tabs 整个不渲染，「打开网页」入口也随之不存在。 */
function stubWithCodeFile() {
  const overrides = {
    'fs.list': {
      tree: [
        {
          name: 'web',
          path: 'web',
          type: 'dir',
          children: [{ name: 'page.html', path: 'web/page.html', type: 'file' }],
        },
      ],
    },
    'fs.read': { path: 'web/page.html', content: '<html><body>stub</body></html>' },
  };
  return stubHtmlCdp().replace(
    '<div id="root"></div>',
    '<div id="root"></div>\n<script>window.__RPC_OVERRIDES__ = ' +
      JSON.stringify(overrides) +
      ';</script>',
  );
}

/** iframe 几何（一次测量）。 */
interface FrameFit {
  hasPane: boolean;
  /** 父级容器类名（诊断用；高度链上游，修前后都应正常）。 */
  holderCls: string;
  /** 父级容器高度（高度链上游，修前后都应正常）。 */
  holderH: number;
  paneH: number;
  barH: number;
  frameH: number;
  /** iframe 底缘与面板底缘的距离（贴住 = 0）。 */
  bottomGap: number;
}

/**
 * 量网页面板的几何。
 * @param cdp CDP 会话
 * @returns 几何；面板未渲染时 hasPane=false
 */
async function readFrameFit(cdp: CdpSession): Promise<FrameFit> {
  const raw = (await cdp.evaluate(`(function(){
    var pane = document.querySelector('.web-pane');
    var frame = document.querySelector('.web-frame');
    if (!pane || !frame) return { hasPane: false };
    // tabpane 的定位不锚死 antd 类名（v6 起内部类名会漂），直接量父级；类名一并带回便于诊断。
    var holder = pane.parentElement;
    var bar = pane.querySelector('.web-bar');
    var pr = pane.getBoundingClientRect();
    var fr = frame.getBoundingClientRect();
    return {
      hasPane: true,
      holderCls: holder ? holder.className : '',
      holderH: holder ? holder.getBoundingClientRect().height : 0,
      paneH: pr.height,
      barH: bar ? bar.getBoundingClientRect().height : 0,
      frameH: fr.height,
      bottomGap: pr.bottom - fr.bottom
    };
  })()`)) as Partial<FrameFit>;
  if (!raw.hasPane) {
    return { hasPane: false, holderCls: '', holderH: 0, paneH: 0, barH: 0, frameH: 0, bottomGap: 0 };
  }
  return raw as FrameFit;
}

/**
 * 判据本身：iframe 必须填满地址栏以下的剩余高度。
 * @param fit 几何
 * @returns 违规描述数组（空数组 = 通过）
 */
function violationsOf(fit: FrameFit): string[] {
  const out: string[] = [];
  if (!fit.hasPane) {
    out.push('网页面板没有渲染');
    return out;
  }
  // 意义守卫：tabpane 高度链（2026-10-31 已修）必须正常，否则量的是别的问题。
  if (fit.holderH <= 400) {
    out.push(
      `意义守卫失败：tabpane 只有 ${String(fit.holderH)}px（应 >400），高度链上游已断，判据失去意义`,
    );
    return out;
  }
  if (fit.frameH < fit.holderH - fit.barH - 4) {
    out.push(
      `iframe 没有填满面板（iframe ${String(fit.frameH)}px / tabpane ${String(fit.holderH)}px − 地址栏 ${String(fit.barH)}px）`,
    );
  }
  if (fit.bottomGap > 4) {
    out.push(`iframe 底部悬空 ${String(fit.bottomGap)}px（未贴住面板底缘）`);
  }
  return out;
}

test('网页面板 iframe 必须填满地址栏以下高度（附正对照：撤掉限高必须变红）', { timeout: 120_000 }, async (t) => {
  const page = await openStubSession(t, {
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    html: stubWithCodeFile(),
  });
  if (page === null) return;
  try {
    const { cdp } = page;
    // 先开一个文件标签让标签条渲染（tabCount=0 时 antd Tabs 与「打开网页」入口都不存在）。
    // 「文件」区块默认可能已展开：已见 treeitem 就不点（点了反而折叠）；未展开才点，
    // 且带重试（app 初始 RPC 批次在飞时 sec-toggle 可能还没渲染，点空一次就放弃会假红）。
    const treeUp = async (tries: number): Promise<boolean> => {
      for (let i = 0; i < tries; i++) {
        if (await cdp.evaluate("!!document.querySelector('.tree [role=\"treeitem\"]')")) return true;
        await cdp.evaluate(`(function(){
          var hit=[].slice.call(document.querySelectorAll('.sec-toggle')).filter(function(b){ return (b.textContent||'').includes('文件'); })[0];
          if (hit) hit.click(); return !!hit;
        })()`);
        await new Promise((r) => setTimeout(r, 500));
      }
      return false;
    };
    assert.ok(
      await treeUp(10),
      '文件树没有渲染（判据失去意义）: ' +
        JSON.stringify(
          await cdp.evaluate(
            `(function(){ return {
              secToggles: [].slice.call(document.querySelectorAll('.sec-toggle')).length,
              composer: !!document.querySelector('.composer-input textarea'),
              rootChildren: document.getElementById('root') ? document.getElementById('root').children.length : -1,
              diagErrors: (window.__READY__ === true) ? 'ready' : 'not-ready'
            }; })()`,
          ),
        ),
    );
    const clickTree = async (label: string): Promise<boolean> =>
      (await cdp.evaluate(`(function(){
        var items=[].slice.call(document.querySelectorAll('.tree [role="treeitem"]'));
        var f=items.filter(function(el){ return (el.textContent||'').trim().indexOf('${label}')===0; })[0];
        if (!f) return false;
        var w=f.querySelector('.ant-tree-node-content-wrapper'); (w||f).click(); return true;
      })()`)) === true;
    assert.strictEqual(await clickTree('web'), true, '展不开 web 目录');
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(await clickTree('page.html'), true, '打不开 page.html');
    // 打开 HTML 会自动触发预览（FileController.openFile → onPreview）⇒ 网页标签直接激活；
    // stub 没有预览源端口 ⇒ 落在「本地网页预览未启用」错误态，但地址栏已渲染，可直接导航。
    assert.ok(await cdp.waitFor("!!document.querySelector('.web-addr')", 4000), '网页面板没有出现地址栏');

    // 导航到一个绝对 URL（不需要预览源端口；404 无妨——量的是 iframe 元素自身的几何）。
    const target = (await cdp.evaluate("location.origin + '/_web-pane-probe-404.html'")) as string;
    await cdp.type('.web-addr', target);
    await cdp.click('.web-go');
    assert.ok(await cdp.waitFor("!!document.querySelector('.web-frame')", 4000), 'iframe 没有渲染');

    // 等 iframe 布局稳定（首帧可能还在插入中）。
    await new Promise((r) => setTimeout(r, 300));
    const fit = await readFrameFit(cdp);
    assert.deepStrictEqual(violationsOf(fit), [], '网页面板 iframe 高度不足（页面显示不全）');

    // ── 正对照：把修复前的状态注回去（`.web-pane` 恢复无高度约束），判据必须能抓到 ────────
    await cdp.evaluate(`(function(){
      var s = document.createElement('style');
      s.id = 'pre-fix-web-pane';
      s.textContent = '.web-pane{height:auto!important}';
      document.head.appendChild(s);
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 300));
    const broken = await readFrameFit(cdp);
    assert.ok(
      violationsOf(broken).length > 0,
      `正对照失败：撤掉限高后判据仍然是绿的（实测 ${JSON.stringify(broken)}，判据恒真）`,
    );
    // 复原，避免影响后续判据
    await cdp.evaluate("document.getElementById('pre-fix-web-pane').remove(); true");
  } finally {
    await page.close();
  }
});
