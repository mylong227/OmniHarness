// 面板模态「不跳尺寸」判据（真机）。
//
// ## 用户报障
//
// 「切换功能面板标签时，面板会出现大小跳动」。这不是观感问题，而是两条布局事实叠出来的：
//
//   1. `.panel-modal` 以前是 `height:auto`：左导航项的固有高度（~619px）撑住短面板，
//      切到「配置集」这种长内容时整窗长到 ~749px，并因遮罩居中被重新摆放（top 75→113）；
//   2. 范围徽标以前写成 `class="scope-chip session"`：`session` 撞上左栏会话行的通用类
//      `.session { display:flex; min-height:34px }`，会话类面板的顶栏比工作区类高 9px。
//
// 现在几何契约是：模态 `min(760px,86vh) × min(880px,92vw)`，顶栏 52px，内容区独占滚动，
// 切面板 scrollTop 归零。本判据逐项**量真机 rect**——CSS 源码断言挡不住"某条新规则又把它撑开"。
//
// ## 判据
//
// A. 1440×900 打开面板模态，逐个点左导航 15 项：模态宽/高/left/top 与顶栏高必须全程不变（±0.5px）；
// B. 视口压到 1440×540：配置集内容形成滚动区，滚到 120px 后切「编排」——
//    编排同样超长（防"变短自动归零"的假绿），内容区 scrollTop 必须归零，新面板从头读。
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { openStubSession, type CdpSession } from './browserHarness.ts';

/** 与用户截图同档的桌面视口。 */
const VIEWPORT = { width: 1440, height: 900 };

/** 模态几何（CSS 像素，已四舍五入到 0.1）。 */
interface Geometry {
  w: number;
  h: number;
  top: number;
  left: number;
  topH: number;
}

/**
 * 读一次模态几何。
 * @param cdp CDP 会话
 * @returns 几何；模态不在时 null
 */
async function readGeometry(cdp: CdpSession): Promise<Geometry | null> {
  const raw = (await cdp.evaluate(`(function(){
    var m = document.querySelector('.panel-modal');
    var t = document.querySelector('.panel-modal .sp-top');
    if (m === null || t === null) return null;
    var r = m.getBoundingClientRect();
    var tr = t.getBoundingClientRect();
    return { w: r.width, h: r.height, top: r.top, left: r.left, topH: tr.height };
  })()`)) as Geometry | null;
  if (raw === null) return null;
  const round = (n: number): number => Math.round(n * 10) / 10;
  return {
    w: round(raw.w),
    h: round(raw.h),
    top: round(raw.top),
    left: round(raw.left),
    topH: round(raw.topH),
  };
}

test(
  '面板模态：切换左导航时窗口几何恒定，且切换后面板从头读',
  { timeout: 120_000 },
  async (t) => {
    const page = await openStubSession(t, VIEWPORT);
    if (page === null) return;
    try {
      const cdp = page.cdp;
      const opened = await cdp.evaluate(`(function(){
        var b = document.querySelector('.pp-btn');
        if (b === null) return false;
        b.click();
        return true;
      })()`);
      assert.strictEqual(opened, true, '找不到「全部面板」按钮（.pp-btn），入口可能被改名');
      assert.ok(
        await cdp.waitFor("!!document.querySelector('.panel-modal .sp-nav-item')", 1500),
        '面板模态没有渲染出左导航',
      );

      const base = await readGeometry(cdp);
      assert.ok(base !== null, '量不到 .panel-modal 的几何');
      assert.ok(base.w > 0 && base.h > 0, `模态尺寸异常：${String(base.w)}×${String(base.h)}`);

      const count = Number(
        await cdp.evaluate("document.querySelectorAll('.panel-modal .sp-nav-item').length"),
      );
      assert.ok(count >= 10, `左导航项过少（${String(count)}），判据覆盖不足`);

      // ── A. 逐个面板切换：几何恒定 ─────────────────────────────────────────
      for (let i = 0; i < count; i += 1) {
        const clicked = await cdp.evaluate(
          `(function(){
            var items = document.querySelectorAll('.panel-modal .sp-nav-item');
            if (items[${String(i)}] === undefined) return false;
            items[${String(i)}].click();
            return true;
          })()`,
        );
        assert.strictEqual(clicked, true, `点不到第 ${String(i + 1)} 个左导航项`);
        await new Promise((r) => setTimeout(r, 90));
        const now = await readGeometry(cdp);
        assert.ok(now !== null, `切到第 ${String(i + 1)} 个面板后模态消失`);
        for (const key of ['w', 'h', 'top', 'left', 'topH'] as const) {
          assert.ok(
            Math.abs(now[key] - base[key]) <= 0.5,
            `切到第 ${String(i + 1)} 个面板后 ${key} 从 ${String(base[key])} 变成 ${String(now[key])}：面板又跳尺寸了`,
          );
        }
      }

      // ── B. 矮视口：内容可滚，切面板后滚动位置归零 ─────────────────────────
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: VIEWPORT.width,
        height: 540,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await new Promise((r) => setTimeout(r, 300));

      const pick = async (pane: string): Promise<boolean> =>
        (await cdp.evaluate(
          `(function(){
            var b = document.querySelector('.panel-modal [data-pane="${pane}"]');
            if (b === null) return false;
            b.click();
            return true;
          })()`,
        )) === true;

      assert.strictEqual(await pick('profiles'), true, '左导航缺少 profiles（配置集）项');
      const scrollable = await cdp.waitFor(
        `(function(){
          var c = document.querySelector('.panel-modal .sp-content');
          return c !== null && c.scrollHeight > c.clientHeight + 40;
        })()`,
        600,
      );
      assert.ok(scrollable, '矮视口下配置集内容没有形成滚动区（判据失去意义）');

      const scrolled = Number(
        await cdp.evaluate(`(function(){
          var c = document.querySelector('.panel-modal .sp-content');
          c.scrollTop = 120;
          return c.scrollTop;
        })()`),
      );
      assert.ok(scrolled > 0, '内容区设置 scrollTop 后仍为 0（判据失去意义）');

      assert.strictEqual(await pick('graph'), true, '左导航缺少 graph（编排）项');
      await new Promise((r) => setTimeout(r, 300));
      const after = (await cdp.evaluate(`(function(){
        var c = document.querySelector('.panel-modal .sp-content');
        var on = document.querySelector('.panel-modal [data-pane="graph"].on');
        return { top: c.scrollTop, scrollH: c.scrollHeight, clientH: c.clientHeight, on: on !== null };
      })()`)) as { top: number; scrollH: number; clientH: number; on: boolean };
      assert.strictEqual(after.on, true, '点了「编排」但左导航未标记为当前面板');
      assert.ok(
        after.scrollH > after.clientH + 40,
        `编排内容在矮视口下没有超长（${String(after.scrollH)} vs ${String(after.clientH)}），归零断言会假绿`,
      );
      assert.strictEqual(after.top, 0, '切换面板后内容区仍停留在上一个面板的滚动位置');
    } finally {
      await page.close();
    }
  },
);
