// 主题色方案判据（2026-10-31，用户口径：多套主题色、设置里可切、明暗双主题都要支持）。
//
// ## 结构
//
// 六套方案（ink 靛墨 / moss 苔青 / plum 绛紫 / amber 琥珀 / rose 玫红 / graphite 石墨），每套都带
// dark / light 两份签名三色（palette.ts `SCHEMES` 是 TS 侧事实源；theme.css 的
// `[data-theme][data-scheme]` 块是 CSS 侧镜像；基础块 = ink，`<html>` 无 data-scheme 即 ink）。
//
// ## 判据
//
// ① **静态对齐**：theme.css 方案块与 palette.ts SCHEMES 逐值一致（双源漂移即红）；
//    ink 必须等于基础 DARK/LIGHT 的同名三色；brand 系四枚镜像必须与 accent/ink-fg 同值。
// ② **对比度**：每套方案 × 明暗，accent 对 bg/panel、ink-fg 对 accent 全部 ≥4.5（WCAG AA）。
// ③ **真机**：设置里点方案 → `data-scheme` 即时生效、--accent 等于该方案的值、
//    localStorage 持久化；刷新后首帧脚本恢复同一方案（防"刷新闪回默认"）；
//    antd 的 `--ant-color-primary` 跟着方案走（签名色接进组件库，不是只有 CSS 变量在换）。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { openStubSession, type CdpSession } from './browserHarness.ts';
import { DARK, LIGHT, SCHEMES, type SchemeColors, type ThemeScheme } from '../src/ui/theme/palette.ts';
import { contrastRatio } from '../src/ui/theme/contrast.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 从 theme.css 解析出全部方案块：mode × scheme → 变量表。 */
function parseSchemeBlocks(): Map<string, Record<string, string>> {
  const css = readFileSync(join(HERE, '../styles/theme.css'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  const out = new Map<string, Record<string, string>>();
  for (const m of css.matchAll(
    /\[data-theme='(dark|light)'\]\[data-scheme='(\w+)'\]\s*\{([^{}]*)\}/g,
  )) {
    const vars: Record<string, string> = {};
    for (const part of m[3].split(';')) {
      const i = part.indexOf(':');
      if (i >= 0) vars[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    out.set(`${m[1]}:${m[2]}`, vars);
  }
  return out;
}

test('① theme.css 方案块与 palette.ts SCHEMES 逐值一致（含 ink=基础值与镜像一致性）', () => {
  // ink 是缺省方案：theme.css 基础块就是它，必须与 DARK/LIGHT 的签名三色逐值一致。
  assert.strictEqual(SCHEMES.ink.dark.accent, DARK.accent, 'ink.dark.accent 必须 = DARK.accent');
  assert.strictEqual(SCHEMES.ink.light.accent, LIGHT.accent, 'ink.light.accent 必须 = LIGHT.accent');
  const blocks = parseSchemeBlocks();
  for (const scheme of Object.keys(SCHEMES) as ThemeScheme[]) {
    if (scheme === 'ink') continue; // ink 无专属块（缺省即它）
    for (const mode of ['dark', 'light'] as const) {
      const vars = blocks.get(`${mode}:${scheme}`);
      assert.ok(vars !== undefined, `theme.css 缺 [data-theme='${mode}'][data-scheme='${scheme}'] 块`);
      const s: SchemeColors = SCHEMES[scheme][mode];
      assert.strictEqual(vars['--accent'], s.accent, `${mode}/${scheme} --accent 双源漂移`);
      assert.strictEqual(vars['--accent-2'], s.accent2, `${mode}/${scheme} --accent-2 双源漂移`);
      assert.strictEqual(vars['--ink-fg'], s.inkFg, `${mode}/${scheme} --ink-fg 双源漂移`);
      // 镜像四枚必须随方案一起换（否则换肤后品牌元素还挂旧色）。
      assert.strictEqual(vars['--brand'], s.accent, `${mode}/${scheme} --brand 没跟随 accent`);
      assert.strictEqual(vars['--brand-bg'], s.accent, `${mode}/${scheme} --brand-bg 没跟随 accent`);
      assert.strictEqual(vars['--user'], s.accent, `${mode}/${scheme} --user 没跟随 accent`);
      assert.strictEqual(vars['--brand-on'], s.inkFg, `${mode}/${scheme} --brand-on 没跟随 ink-fg`);
    }
  }
});

test('② 每套方案 × 明暗：accent 对 bg/panel、ink-fg 对 accent 全部 ≥4.5（AA）', () => {
  const violations: string[] = [];
  for (const scheme of Object.keys(SCHEMES) as ThemeScheme[]) {
    for (const mode of ['dark', 'light'] as const) {
      const s: SchemeColors = SCHEMES[scheme][mode];
      const surfaces = mode === 'dark' ? { bg: DARK.bg, panel: DARK.panel } : { bg: LIGHT.bg, panel: LIGHT.panel };
      for (const [surface, hex] of Object.entries(surfaces)) {
        const r = contrastRatio(s.accent, hex);
        if (r === null) violations.push(`${scheme}/${mode}: accent×${surface} 颜色不可解析`);
        else if (r < 4.5) violations.push(`${scheme}/${mode}: accent×${surface} = ${r.toFixed(2)}`);
      }
      const rFg = contrastRatio(s.inkFg, s.accent);
      if (rFg === null) violations.push(`${scheme}/${mode}: ink-fg×accent 颜色不可解析`);
      else if (rFg < 4.5) violations.push(`${scheme}/${mode}: ink-fg×accent = ${rFg.toFixed(2)}`);
    }
  }
  assert.deepStrictEqual(violations, [], '方案色对比度不达 AA');
});

/** 真机量一次：data-scheme 属性、--accent 解析值、antd 主色变量、localStorage。 */
interface SchemeProbe {
  attr: string | null;
  accent: string;
  antPrimary: string;
  stored: string | null;
}

/**
 * 读方案生效状态。
 * @param cdp CDP 会话
 * @returns 探针结果
 */
async function readSchemeState(cdp: CdpSession): Promise<SchemeProbe> {
  return (await cdp.evaluate(`(function(){
    var root = document.documentElement;
    var app = document.querySelector('.ant-app');
    return {
      attr: root.getAttribute('data-scheme'),
      accent: getComputedStyle(root).getPropertyValue('--accent').trim(),
      antPrimary: app ? getComputedStyle(app).getPropertyValue('--ant-color-primary').trim() : '',
      stored: localStorage.getItem('omni-theme-scheme')
    };
  })()`)) as SchemeProbe;
}

for (const theme of ['dark', 'light'] as const) {
  test(`③ 真机：${theme} 主题下设置里切换方案即时生效、持久化、antd 主色跟随`, { timeout: 120_000 }, async (t) => {
    const page = await openStubSession(t, { width: 1600, height: 1000 });
    if (page === null) return;
    try {
      const { cdp } = page;
      // 以**显式主题偏好**重启到目标明暗：antd 的 token 在 React 挂载时定型，
      // 直接改 DOM 属性骗得了 CSS 骗不了 React 状态（--ant-color-primary 仍是挂载主题）。
      // 所以先写 localStorage 再重载，让 app 以目标主题启动——与真实用户路径一致。
      await cdp.evaluate(`(function(){
        localStorage.setItem('omni-theme', '${theme}');
        localStorage.removeItem('omni-theme-scheme');
        return true;
      })()`);
      await cdp.navigate((await cdp.evaluate('location.href')) as string);
      // 关过渡（同 colorSystem ③：切换瞬间读 computed 会拿到过渡起点的颜色）。
      await cdp.evaluate(`(function(){
        var s = document.createElement('style');
        s.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}';
        document.head.appendChild(s);
        return true;
      })()`);
      await cdp.waitFor("!!document.querySelector('.composer-input textarea')", 2000);
      // 打开设置（工作台控制台）
      await cdp.evaluate(`(function(){
        var b = document.querySelector('.side-foot button[aria-label=\"打开设置\"]');
        if (b) b.click();
        return !!b;
      })()`);
      assert.ok(
        await cdp.waitFor("!!document.querySelector('.csl-seg[aria-label=\\\"主题色\\\"]')", 4000),
        '设置里没有渲染「主题色」分段控件',
      );

      const violations: string[] = [];
      for (const scheme of Object.keys(SCHEMES) as ThemeScheme[]) {
        const label = { ink: '靛墨', moss: '苔青', plum: '绛紫', amber: '琥珀', rose: '玫红', graphite: '石墨' }[scheme];
        const clicked = await cdp.evaluate(`(function(){
          var seg = document.querySelector('.csl-seg[aria-label=\"主题色\"]');
          var hit = [].slice.call(seg.querySelectorAll('button.csl-seg-item')).filter(function(b){
            return (b.textContent || '').trim() === '${label}';
          })[0];
          if (!hit) return false;
          hit.click();
          return true;
        })()`);
        assert.strictEqual(clicked, true, `找不到方案选项「${label}」`);
        await new Promise((r) => setTimeout(r, 200));
        // 选中标记必须移动到刚点的项（用户 2026-10-31 截图：切换后没有任何一项高亮——
        // 副作用全生效了、控件 value 却没跟上，就是这条断言要抓的断链）。
        const marked = (await cdp.evaluate(`(function(){
          var seg = document.querySelector('.csl-seg[aria-label=\"主题色\"]');
          var on = [].slice.call(seg.querySelectorAll('button.csl-seg-item.on'));
          return on.map(function(b){ return (b.textContent || '').trim(); }).join(',');
        })()`)) as string;
        if (marked !== label) violations.push(`${scheme}: 选中标记停在「${String(marked)}」，应为「${label}」`);
        const probe = await readSchemeState(cdp);
        const expected = SCHEMES[scheme][theme].accent;
        const wantAttr = scheme === 'ink' ? null : scheme;
        if (probe.attr !== wantAttr) {
          violations.push(`${scheme}: data-scheme=${String(probe.attr)}，应为 ${String(wantAttr)}`);
        }
        if (probe.accent.toLowerCase() !== expected.toLowerCase()) {
          violations.push(`${scheme}: --accent=${probe.accent}，应为 ${expected}`);
        }
        if (probe.stored !== scheme) {
          violations.push(`${scheme}: localStorage=${String(probe.stored)}，应为 ${scheme}`);
        }
        // antd 签名色接线：cssVar 模式下 --ant-color-primary 必须等于方案 accent。
        // antd 会把 token 值原样写入变量（hex），只比小写。
        if (probe.antPrimary !== '' && probe.antPrimary.toLowerCase() !== expected.toLowerCase()) {
          violations.push(`${scheme}: --ant-color-primary=${probe.antPrimary}，应为 ${expected}`);
        }
      }
      assert.deepStrictEqual(violations, [], `${theme} 主题下方案切换不生效`);

      // 持久化回环：刷新后首帧脚本必须恢复同一方案（防"刷新闪回默认"）。
      await cdp.evaluate("localStorage.setItem('omni-theme-scheme','moss'); true");
      await cdp.navigate((await cdp.evaluate('location.href')) as string);
      await cdp.waitFor("!!document.querySelector('.composer-input textarea')", 4000);
      const reloaded = await readSchemeState(cdp);
      assert.strictEqual(reloaded.attr, 'moss', '刷新后 data-scheme 没有被首帧脚本恢复');
      assert.strictEqual(
        reloaded.accent.toLowerCase(),
        SCHEMES.moss[theme].accent.toLowerCase(),
        '刷新后 --accent 不是苔青的签名色',
      );
    } finally {
      await page.close();
    }
  });
}
