// 右栏代码正文「显示不全 + 上下滚动无效」的判据（真机）。
//
// ## 用户报障（2026-10-31 截图）
//
// 右栏打开一份长 HTML：长行右缘被硬切（无横向滚动条可用），正文第 39 行以后整段不可见，
// 且无论滚轮还是拖滚动条，画面纹丝不动。
//
// ## 根因（探针实测，修前数据见 git 历史）
//
// ① W2 把右栏标签条换成 antd `Tabs`（v6）后，`.tabs.rv-tabs` 已是**右栏整列容器**，但高度链
//    断了两处：antd 根 `.ant-tabs` 是 `.rv-tabs` 的普通 flex 子项（缺 `flex:1`/`min-height:0`，
//    取内容固有高 4762）；v6 又多出一层 `.ant-tabs-body`（body-holder 的普通 block 子项，
//    root 983 / holder 940 都已限住时它实测 4719）。链一断，`.code-scroll` 变成「内容多高它
//    多高」：自己永远不可滚；溢出顶给 `.col.right`（overflow:auto）再叠上 `.tabs` 的
//    `position:sticky`——整列即使能滚，内容也冻结不动（「上下滚了没反应」）。
// ② `.hl-code` 基础样式自带 `overflow:auto`，是 flex 子项时自动最小尺寸为 0：宽行被它自己
//    内部横滚吸收（滚动条沉在几千像素的内容底部够不着，表现为「长行被切」）；高度链修通后
//    它还会被 stretch 压到视口高、长出自己的纵向滚动条，与行号 gutter 各滚各的（错位）。
//
// ## 判据
//
// A. 代码正文必须**内部自持滚动**：纵向 `scrollHeight > clientHeight` 且 `scrollTop` 可真实
//    改变；横向长行同理（`scrollLeft` 可变）；
// B. 滚动源唯一：`.hl-code` 自身不得可滚（两轴），gutter 横滚后必须钉在左缘（sticky left）；
// C. `.col.right` 整列不得出现纵向溢出（`col.scrollHeight ≤ col.clientHeight + 1`）——
//    这是「内容被顶出面板」的信号；
// D. **正对照**：把修复撤掉（`.ant-tabs` 恢复不限高），判据必须变红——否则这条判据恒真。
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { openStubSession, stubHtmlCdp, type CdpSession } from './browserHarness.ts';

/** 与用户截图同档的桌面视口。 */
const VIEWPORT = { width: 1600, height: 1000 };

/** 夹具：240 行代码 + 一条超长行，纵横向都远超一屏（预览上限 40KB，远未触顶）。 */
function longCodeFile(): string {
  const lines: string[] = [];
  for (let i = 1; i <= 240; i++) {
    lines.push(`export const line_${i} = ${i}; // 第 ${i} 行，用来把正文撑过一屏`);
  }
  lines.splice(3, 0, `const veryLongLine = "${'x'.repeat(900)}";`);
  return lines.join('\n');
}

/** 桩页要带文件树与一份长代码文件。 */
function stubWithCodeFile() {
  const overrides = {
    'fs.list': {
      tree: [
        {
          name: 'web',
          path: 'web',
          type: 'dir',
          children: [{ name: 'long.ts', path: 'web/long.ts', type: 'file' }],
        },
      ],
    },
    'fs.read': { path: 'web/long.ts', content: longCodeFile() },
  };
  return stubHtmlCdp().replace(
    '<div id="root"></div>',
    '<div id="root"></div>\n<script>window.__RPC_OVERRIDES__ = ' +
      JSON.stringify(overrides) +
      ';</script>',
  );
}

/** 量一次代码正文滚动几何（先尝试把两个轴都滚起来，再读回实际值）。 */
interface ScrollFit {
  hasCode: boolean;
  sh: number;
  ch: number;
  sw: number;
  cw: number;
  vTop: number;
  hLeft: number;
  /** 高亮正文（.hl-code）自身的滚动几何——它必须是「不滚的」，滚动只能有一处。 */
  preSH: number;
  preCH: number;
  preSW: number;
  preCW: number;
  /** 横滚后 gutter 的左缘与滚动容器左缘（sticky left 生效则两者重合）。 */
  gutterLeft: number;
  csLeft: number;
  colSH: number;
  colCH: number;
}

/**
 * 读代码正文与右栏整列的滚动几何。
 * @param cdp CDP 会话
 * @returns 几何；代码正文或右栏不在时 hasCode=false
 */
async function readScroll(cdp: CdpSession): Promise<ScrollFit> {
  const raw = (await cdp.evaluate(`(function(){
    var cs = document.querySelector('.code-scroll');
    var col = document.querySelector('.col.right');
    if (!cs || !col) return { hasCode: false };
    cs.scrollTop = 220; cs.scrollLeft = 150;
    var pre = cs.querySelector('.hl-code');
    var gut = cs.querySelector('.code-gutter');
    return {
      hasCode: true,
      sh: cs.scrollHeight, ch: cs.clientHeight,
      sw: cs.scrollWidth, cw: cs.clientWidth,
      vTop: cs.scrollTop, hLeft: cs.scrollLeft,
      preSH: pre ? pre.scrollHeight : 0, preCH: pre ? pre.clientHeight : 0,
      preSW: pre ? pre.scrollWidth : 0, preCW: pre ? pre.clientWidth : 0,
      gutterLeft: gut ? gut.getBoundingClientRect().left : -1,
      csLeft: cs.getBoundingClientRect().left,
      colSH: col.scrollHeight, colCH: col.clientHeight
    };
  })()`)) as Partial<ScrollFit>;
  if (!raw.hasCode) {
    return {
      hasCode: false, sh: 0, ch: 0, sw: 0, cw: 0, vTop: 0, hLeft: 0,
      preSH: 0, preCH: 0, preSW: 0, preCW: 0, gutterLeft: 0, csLeft: 0, colSH: 0, colCH: 0,
    };
  }
  return raw as ScrollFit;
}

/**
 * 判据本身：正文必须内部可滚（两轴）、且滚动只能发生在 `.code-scroll` 一处，
 * 右栏整列不得溢出。
 * @param fit 几何
 * @returns 违规描述数组（空数组 = 通过）
 */
function violationsOf(fit: ScrollFit): string[] {
  const out: string[] = [];
  if (!fit.hasCode) {
    out.push('代码正文没有渲染');
    return out;
  }
  if (fit.vTop < 100) {
    out.push(`纵向滚动无效：scrollTop 停在 ${String(fit.vTop)}（内容 ${String(fit.sh)} / 视口 ${String(fit.ch)}）`);
  }
  if (fit.hLeft < 60) {
    out.push(`横向滚动无效：scrollLeft 停在 ${String(fit.hLeft)}（内容 ${String(fit.sw)} / 视口 ${String(fit.cw)}）`);
  }
  // 滚动源唯一性：`.hl-code` 若自己也能滚（纵或横），行号 gutter 就与正文各滚各的（错位）。
  if (fit.preSH > fit.preCH + 10) {
    out.push(
      `正文自己内部纵向滚动（pre ${String(fit.preSH)} > ${String(fit.preCH)}），行号将与正文错位`,
    );
  }
  if (fit.preSW > fit.preCW + 10) {
    out.push(
      `正文自己内部横向滚动（pre ${String(fit.preSW)} > ${String(fit.preCW)}），滚动条会沉到内容底部`,
    );
  }
  if (Math.abs(fit.gutterLeft - fit.csLeft) > 2) {
    out.push(
      `gutter 没有钉在左缘（gutter ${String(fit.gutterLeft)} vs 容器 ${String(fit.csLeft)}），sticky left 失效`,
    );
  }
  if (fit.colSH > fit.colCH + 1) {
    out.push(`右栏整列纵向溢出 ${String(fit.colSH)} > ${String(fit.colCH)}（内容被顶出面板）`);
  }
  return out;
}

test('右栏代码正文必须内部自持滚动（附正对照：撤掉限高必须变红）', { timeout: 120_000 }, async (t) => {
  const page = await openStubSession(t, {
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    html: stubWithCodeFile(),
  });
  if (page === null) return;
  try {
    const { cdp } = page;
    // 展开「文件」区块 → 展开 web → 打开 long.ts
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
    assert.strictEqual(await clickTree('long.ts'), true, '打不开 long.ts');
    assert.ok(await cdp.waitFor("!!document.querySelector('.code-scroll')", 3000), '代码正文没有渲染');

    const fit = await readScroll(cdp);
    // 意义守卫：夹具必须真的在两个轴上都超出视口，否则判据在量恒真值。
    assert.ok(fit.hasCode, '量不到代码正文');
    assert.ok(
      fit.sh > fit.ch + 60,
      `夹具纵向不够长（内容 ${String(fit.sh)} / 视口 ${String(fit.ch)}），判据失去意义`,
    );
    assert.ok(
      fit.sw > fit.cw + 60,
      `夹具横向不够宽（内容 ${String(fit.sw)} / 视口 ${String(fit.cw)}），判据失去意义`,
    );
    assert.deepStrictEqual(violationsOf(fit), [], '右栏代码正文不能自持滚动');

    // ── 正对照：把修复前的状态注回去（`.ant-tabs` 恢复不限高），判据必须能抓到 ────────
    await cdp.evaluate(`(function(){
      var s = document.createElement('style');
      s.id = 'pre-fix-rv-tabs';
      s.textContent = '.rv-tabs .ant-tabs{flex:0 1 auto!important;min-height:auto!important}';
      document.head.appendChild(s);
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 300));
    const broken = await readScroll(cdp);
    assert.ok(
      violationsOf(broken).length > 0,
      `正对照失败：撤掉限高后判据仍然是绿的（实测 ${JSON.stringify(broken)}，判据恒真）`,
    );
    // 复原，避免影响后续判据
    await cdp.evaluate("document.getElementById('pre-fix-rv-tabs').remove(); true");
  } finally {
    await page.close();
  }
});
