// 右栏文件正文「被两侧裁剪」的判据（真机）。
//
// ## 用户报障（2026-10-30 截图）
//
// 右侧文件显示区的正文左右两侧都被切掉，路径栏也看不见了。
//
// ## 根因（实测数据，不是猜测）
//
// `.rv-tabs` 换成 antd `Tabs` 后**已经是右栏整列容器**（flex 列），但 `shell.css` 里还留着
// 旧标签条的样式：`align-items: center` + `overflow-x: auto`。于是：
//
//   · `align-items: center` 让 antd root 不拉伸，宽度 = 内容固有宽（实测 **839px**，列只有 420px）；
//   · 居中的结果是内容左边界跑到列外（实测 x=971，列从 1180 开始），两侧各溢出 ~210px；
//   · `overflow-x: auto` 把溢出变成"可滚动"，但滚动条被隐藏，用户只看到**两侧被切**
//     （路径栏同理被推到可视区左侧之外，所以"消失"了）。
//
// ## 判据
//
// A. 内容矩形必须落在 `.col.right` 内（±1px），`.rv-tabs` 不得有横向溢出；
// B. **正对照**：把旧规则（`align-items:center; overflow-x:auto`）注回去，判据必须变红——
//    否则这条判据只是"量了个恒真值"。
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { openStubSession, stubHtmlCdp, type CdpSession } from './browserHarness.ts';

/** 与用户截图同档的桌面视口。 */
const VIEWPORT = { width: 1600, height: 1000 };

/** 桩页要带文件树与一份 markdown（正文长到足以撑出固有宽度）。 */
function stubWithFile() {
  const overrides = {
    'fs.list': {
      tree: [
        {
          name: 'web',
          path: 'web',
          type: 'dir',
          children: [{ name: 'README.md', path: 'web/README.md', type: 'file' }],
        },
      ],
    },
    'fs.read': {
      path: 'web/README.md',
      content:
        '# 标题\n\n这是一段很长的正文，用来检查右侧文件显示区是否被裁剪：它应该在卡片内换行，' +
        '而不是被左右两侧切掉。\n\n- 列表项一\n- 列表项二\n\n```ts\n' +
        'const veryLongLine = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";\n```\n',
    },
  };
  return stubHtmlCdp().replace(
    '<div id="root"></div>',
    '<div id="root"></div>\n<script>window.__RPC_OVERRIDES__ = ' +
      JSON.stringify(overrides) +
      ';</script>',
  );
}

/** 量一次右栏几何（CSS 像素，保留 0.1）。 */
interface Fit {
  colLeft: number;
  colRight: number;
  paneLeft: number;
  paneRight: number;
  pathLeft: number;
  tabsScrollW: number;
  tabsClientW: number;
  mdScrollW: number;
  mdClientW: number;
  hasPathbar: boolean;
}

/**
 * 读右栏几何。
 * @param cdp CDP 会话
 * @returns 几何；右栏或内容不在时 null
 */
async function readFit(cdp: CdpSession): Promise<Fit | null> {
  const raw = (await cdp.evaluate(`(function(){
    var col = document.querySelector('.col.right');
    var pane = document.querySelector('.ant-tabs-content');
    var tabs = document.querySelector('.rv-tabs');
    var path = document.querySelector('.rv-pathbar');
    var md = document.querySelector('.file-md-scroll');
    if (!col || !pane || !tabs) return null;
    var cr = col.getBoundingClientRect(), pr = pane.getBoundingClientRect();
    var pr2 = path ? path.getBoundingClientRect() : null;
    return {
      colLeft: cr.left, colRight: cr.right,
      paneLeft: pr.left, paneRight: pr.right,
      pathLeft: pr2 ? pr2.left : -1,
      tabsScrollW: tabs.scrollWidth, tabsClientW: tabs.clientWidth,
      mdScrollW: md ? md.scrollWidth : 0, mdClientW: md ? md.clientWidth : 0,
      hasPathbar: pr2 !== null,
    };
  })()`)) as Fit | null;
  if (raw === null) return null;
  const r = (n: number): number => Math.round(n * 10) / 10;
  return {
    colLeft: r(raw.colLeft),
    colRight: r(raw.colRight),
    paneLeft: r(raw.paneLeft),
    paneRight: r(raw.paneRight),
    pathLeft: r(raw.pathLeft),
    tabsScrollW: raw.tabsScrollW,
    tabsClientW: raw.tabsClientW,
    mdScrollW: raw.mdScrollW,
    mdClientW: raw.mdClientW,
    hasPathbar: raw.hasPathbar,
  };
}

/**
 * 判据本身：内容必须在列内、且文件正文没有横向溢出。
 * @param fit 几何
 * @returns 违规描述数组（空数组 = 通过）
 */
function violationsOf(fit: Fit): string[] {
  const out: string[] = [];
  if (fit.paneLeft < fit.colLeft - 1) {
    out.push(`内容左边界 ${String(fit.paneLeft)} 越出列左 ${String(fit.colLeft)}`);
  }
  if (fit.paneRight > fit.colRight + 1) {
    out.push(`内容右边界 ${String(fit.paneRight)} 越出列右 ${String(fit.colRight)}`);
  }
  if (fit.tabsScrollW > fit.tabsClientW + 1) {
    out.push(`右栏列横向溢出 ${String(fit.tabsScrollW)} > ${String(fit.tabsClientW)}`);
  }
  if (fit.mdScrollW > fit.mdClientW + 1) {
    out.push(`文件正文横向溢出 ${String(fit.mdScrollW)} > ${String(fit.mdClientW)}`);
  }
  if (!fit.hasPathbar) out.push('路径栏没有渲染');
  return out;
}

test('右栏文件正文不得被两侧裁剪（附正对照：旧规则注回去必须变红）', { timeout: 120_000 }, async (t) => {
  const page = await openStubSession(t, {
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    html: stubWithFile(),
  });
  if (page === null) return;
  try {
    const { cdp } = page;
    // 展开「文件」区块 → 展开 web → 打开 README.md
    await cdp.evaluate(`(function(){
      var hit=[].slice.call(document.querySelectorAll('.sec-toggle')).filter(function(b){ return (b.textContent||'').includes('文件'); })[0];
      if (hit) hit.click(); return true;
    })()`);
    assert.ok(
      await cdp.waitFor("!!document.querySelector('.tree [role=\\\"treeitem\\\"]')", 4000),
      '文件树没有渲染（判据失去意义）',
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
    assert.strictEqual(await clickTree('README.md'), true, '打不开 README.md');
    assert.ok(await cdp.waitFor("!!document.querySelector('.file-md-scroll')", 3000), '文件正文没有渲染');

    const fit = await readFit(cdp);
    assert.ok(fit !== null, '量不到右栏几何');
    assert.deepStrictEqual(violationsOf(fit), [], '右栏文件正文被裁剪');
    assert.ok(
      fit.paneRight - fit.paneLeft > 200,
      `内容宽度异常（${String(fit.paneRight - fit.paneLeft)}px），判据可能失去意义`,
    );

    // ── 正对照：把修复前的状态整体注回去，判据必须能抓到 ─────────────────────
    // 只注 `align-items:center` 不足以复现：修复的另一半（`.rv-tabs .ant-tabs{width:100%}`）
    // 单独也能顶住。真正的"修复前"是两处都没有 ⇒ 两处一起撤掉。
    await cdp.evaluate(`(function(){
      var s = document.createElement('style');
      s.id = 'legacy-rv-tabs';
      s.textContent =
        '.rv-tabs{align-items:center!important;overflow-x:auto!important}' +
        '.rv-tabs .ant-tabs{width:auto!important;min-width:auto!important}';
      document.head.appendChild(s);
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 300));
    const broken = await readFit(cdp);
    assert.ok(broken !== null, '注入旧规则后量不到几何');
    assert.ok(
      violationsOf(broken).length > 0,
      '正对照失败：把 align-items:center + overflow-x:auto 注回去后判据仍然是绿的（判据恒真）',
    );
    // 复原，避免影响截图/后续判据
    await cdp.evaluate("document.getElementById('legacy-rv-tabs').remove(); true");
  } finally {
    await page.close();
  }
});
