// 真机判据：悬浮提示必须是「收窄 + 圆角 + 扁平」的自绘纸片，且原生 title 被接管。
//
// 为什么必须在真 Chrome 里量：`max-width` / `border-radius` / `box-shadow` / 实际行数
// 都是**布局与计算样式**，jsdom 没有布局（offsetWidth 恒 0），量不出用户看到的那个方块。
// 这条判据按住用户截图里的四件事：
//   ① 「太宽」：宽度 ≤ 280px（原生气泡会把一句权限说明拉成一条横线）；
//   ② 「扁平设计带圆角」：10px 圆角、无投影；
//   ③ 「主题跟随」：浅色是纯白纸片、深色是暗底墨片（2026-10-28 第三轮：「暗色主题冒泡
//      也需要暗色，而不是白色底」），两边都带 1px 发丝边；
//   ④ 位置：落在触发元素上方、夹在视口内；离开后气泡卸载、title 原样归还。

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { openStubSession, type CdpSession } from './browserHarness.ts';

/** 视口：窄到足以暴露"贴边"问题，又留得下 280px 气泡。 */
const VIEWPORT = { width: 1200, height: 800 };

/** 一次真机度量。 */
interface TipShot {
  /** 气泡宽（px，含 padding 与 1px 边；border-box）。 */
  readonly width: number;
  /** 气泡高（px）。 */
  readonly height: number;
  /** 左缘（视口坐标）。 */
  readonly left: number;
  /** 右缘（视口坐标）。 */
  readonly right: number;
  /** 下缘（视口坐标）。 */
  readonly bottom: number;
  /** 圆角（计算值）。 */
  readonly radius: string;
  /** 投影（计算值）。 */
  readonly shadow: string;
  /** 背景色（计算值）。 */
  readonly bg: string;
  /** 文字色（计算值）。 */
  readonly color: string;
  /** 边框宽（计算值）。 */
  readonly borderWidth: string;
  /** 边框色（计算值）。 */
  readonly borderColor: string;
  /** 行高（px 字符串）。 */
  readonly lineHeight: string;
  /** 气泡文字。 */
  readonly text: string;
  /** 触发元素当前是否还挂着 title（应已摘掉）。 */
  readonly titleLeft: string | null;
  /** 触发元素上缘（视口坐标）。 */
  readonly chipTop: number;
  /** `--tip-bg` / `--tip-fg` 的当前计算值（断言"浅底深字"而不写死主题色）。 */
  readonly tipBg: string;
  readonly tipFg: string;
}

/**
 * 读一次气泡与触发元素的几何/样式。
 * @param cdp CDP 会话
 * @returns 度量；气泡不存在时 null
 */
function readShot(cdp: CdpSession): Promise<TipShot | null> {
  return cdp.evaluate(`(function(){
    var tip = document.querySelector('.hover-tip');
    var chip = document.querySelector('.dd.perm');
    if (!tip || !chip) return null;
    var r = tip.getBoundingClientRect();
    var cr = chip.getBoundingClientRect();
    var cs = getComputedStyle(tip);
    var probe = document.createElement('div');
    document.body.appendChild(probe);
    probe.style.color = 'var(--tip-bg)';
    var tipBg = getComputedStyle(probe).color;
    probe.style.color = 'var(--tip-fg)';
    var tipFg = getComputedStyle(probe).color;
    probe.remove();
    return {
      width: Math.round(r.width), height: Math.round(r.height),
      left: Math.round(r.left), right: Math.round(r.right), bottom: Math.round(r.bottom),
      radius: cs.borderRadius, shadow: cs.boxShadow, bg: cs.backgroundColor, color: cs.color,
      borderWidth: cs.borderTopWidth, borderColor: cs.borderTopColor,
      lineHeight: cs.lineHeight, text: tip.textContent,
      titleLeft: chip.getAttribute('title'), chipTop: Math.round(cr.top),
      tipBg: tipBg, tipFg: tipFg
    };
  })()`) as Promise<TipShot | null>;
}

/**
 * 把 `rgb(r, g, b)` 解析成三通道（解析不了就抛，避免"看起来通过"的静默）。
 * @param value 计算色值
 * @returns 三通道
 */
function rgbOf(value: string): number[] {
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value);
  assert.ok(m !== null, `无法解析色值：${value}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

test(
  '真机：悬停权限 chip —— 浅色纯白 / 深色墨片、最宽 280px、10px 圆角、无投影，且接管原生 title',
  { timeout: 120_000 },
  async (t) => {
    const page = await openStubSession(t, { ...VIEWPORT, waitFor: '.dd.perm' });
    if (page === null) return;
    try {
      const { cdp } = page;
      // title 的原文是"用户悬浮时该看到的完整说明"——气泡必须逐字一致。
      const expected = (await cdp.evaluate(
        `(function(){ var el = document.querySelector('.dd.perm'); return el ? el.getAttribute('title') : null; })()`,
      )) as string | null;
      assert.ok(typeof expected === 'string' && expected.length > 10, '权限 chip 必须带完整说明的 title');

      // —— 浅色主题：底必须是纯白 + 发丝边（用户：「白色主题下也应该是白色的冒泡」）——
      await cdp.evaluate("document.documentElement.setAttribute('data-theme','light')");
      await new Promise((r) => setTimeout(r, 150));
      await cdp.hover('.dd.perm');
      await new Promise((r) => setTimeout(r, 350));
      const light = await readShot(cdp);
      assert.ok(light !== null, '悬停权限 chip 后必须出现自绘气泡（.hover-tip）');

      assert.strictEqual(light.titleLeft, null, '悬停期间原生 title 必须摘掉，否则两套气泡同屏');
      assert.strictEqual(light.text, expected, '气泡文字必须与 title 逐字一致');
      assert.ok(light.width <= 280, `「太宽」：宽度必须 ≤280px，实测 ${String(light.width)}px`);
      assert.strictEqual(light.radius, '10px', '「带圆角」：10px');
      assert.strictEqual(light.shadow, 'none', '「扁平」：不投影');
      assert.strictEqual(light.bg, light.tipBg, '气泡底必须取 --tip-bg');
      assert.strictEqual(light.color, light.tipFg, '气泡字必须取 --tip-fg');
      const lightBg = rgbOf(light.bg);
      assert.ok(
        Math.min(...lightBg) >= 250,
        `浅色主题气泡必须是白的（三通道 ≥250），实测 ${light.bg}`,
      );
      const lightFg = rgbOf(light.color);
      assert.ok(Math.max(...lightFg) <= 80, `浅色主题气泡字必须是深色，实测 ${light.color}`);
      assert.strictEqual(light.borderWidth, '1px', '浅色下白片要有 1px 发丝边才立得住');
      assert.notStrictEqual(light.borderColor, 'rgba(0, 0, 0, 0)', '浅色下的发丝边不能是透明的');

      // —— 深色主题：必须是暗底浅字（用户 2026-10-28：「暗色主题冒泡也需要暗色」） ——
      await cdp.evaluate("document.documentElement.setAttribute('data-theme','dark')");
      await new Promise((r) => setTimeout(r, 150));
      const dark = await readShot(cdp);
      assert.ok(dark !== null, '切主题后气泡应仍在（无需重新悬停）');
      assert.strictEqual(dark.text, expected, '切主题不得改变文案');
      assert.strictEqual(dark.bg, dark.tipBg, '深色下气泡底也要取 --tip-bg');
      const darkBg = rgbOf(dark.bg);
      assert.ok(
        Math.max(...darkBg) <= 80,
        `深色主题气泡必须是暗底（三通道 ≤80），实测 ${dark.bg}`,
      );
      const darkFg = rgbOf(dark.color);
      assert.ok(Math.min(...darkFg) >= 200, `深色主题气泡字必须是浅色，实测 ${dark.color}`);
      assert.strictEqual(dark.borderWidth, '1px', '深色下的墨片同样要有 1px 发丝边');
      assert.notStrictEqual(dark.borderColor, 'rgba(0, 0, 0, 0)', '深色下的发丝边不能是透明的');

      // —— 位置与行数 ——
      assert.ok(
        light.bottom <= light.chipTop,
        `气泡必须在 chip 上方：bottom=${String(light.bottom)} chipTop=${String(light.chipTop)}`,
      );
      assert.ok(light.left >= 8, `气泡左缘必须留在视口内：left=${String(light.left)}`);
      assert.ok(light.right <= VIEWPORT.width - 8, `气泡右缘必须留在视口内：right=${String(light.right)}`);
      const lineHeight = Number.parseFloat(light.lineHeight);
      assert.ok(
        light.height <= Math.ceil(lineHeight * 4 + 14) + 1,
        `气泡最多 4 行：height=${String(light.height)} lineHeight=${light.lineHeight}`,
      );

      // —— 离开：气泡卸载、title 归还 ——
      await cdp.hoverAway();
      await new Promise((r) => setTimeout(r, 150));
      const after = (await cdp.evaluate(`(function(){
        var chip = document.querySelector('.dd.perm');
        return { tip: !!document.querySelector('.hover-tip'), title: chip ? chip.getAttribute('title') : null };
      })()`)) as { tip: boolean; title: string | null };
      assert.strictEqual(after.tip, false, '离开后气泡必须卸载');
      assert.strictEqual(after.title, expected, '离开后 title 必须原样归还');
    } finally {
      await page.close();
    }
  },
);
