// 判据：色彩体系不变量（2026-10-18「纸与墨」重设计后，替代原 monochromeInvariant）。
//
// ## 为什么口径从"单调色"换成"色相预算"
//
// 上一版的世界是零色相（黑/白/灰），所以判据能写成"任何可见颜色都必须是灰阶"。
// 这一版引入了**一个签名色 + 四个低饱和语义色族**，那条判据会把正确的设计判红。
// 但"允许颜色"不等于"放任颜色"：真正要守的性质是——
//
//   ① **颜色必须来自 token**：theme.css 是唯一配色事实源，其它样式表里不许再出现带色相的
//      字面量（历史债务就是 `#3fb950` / `#7c3aed` 这类值散落在结构层，改配色时改不动）。
//   ② **两套主题的 token 必须齐备且语义一致**：同名 token 在明暗里是同一件事。
//   ③ **签名色真的接上了线**：主行动按钮的底色必须等于 `--accent` 的解析值，
//      语义徽标必须等于对应语义 token——否则"定义了 token 但组件没吃"会静默退回继承色。
//
// ①② 是纯静态扫描（改坏立刻红，不需要浏览器）；③ 走真 Chrome（stub 页 + 假后端）。
//
// ## 容差
//
// "带色相"判定：max(r,g,b) - min(r,g,b) > 24。低于它的值在 sRGB 上肉眼读作中性
// （#1e2126 这类"冷石墨"的通道差正好在 8–12，属于允许的中性偏色）。
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { openStubSession } from './browserHarness.ts';

const STYLE_DIR = new URL('../styles', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
/** 通道差上限：超过即视为"带色相"的字面量。 */
const NEUTRAL_SPREAD = 24;

/** 剥掉整段注释（含跨行），避免注释里的历史色值造成假红。 */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** #rgb / #rrggbb → [r,g,b]。 */
function hexToRgb(hex: string): number[] | null {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

/** 三通道极差。 */
function spread([r, g, b]: number[]): number {
  return Math.max(r, g, b) - Math.min(r, g, b);
}

test('① theme.css 之外的样式表不得出现带色相的字面量（颜色必须来自 token）', () => {
  const offenders: string[] = [];
  for (const file of readdirSync(STYLE_DIR).filter((f) => f.endsWith('.css') && f !== 'theme.css')) {
    const lines = stripComments(readFileSync(join(STYLE_DIR, file), 'utf8')).split('\n');
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/#([0-9a-fA-F]{3,8})\b/g)) {
        const rgb = hexToRgb(m[1]);
        if (rgb !== null && spread(rgb) > NEUTRAL_SPREAD) {
          offenders.push(`${file}:${i + 1} → ${m[0]}（请换成 var(--token) 或 color-mix(...)）`);
        }
      }
      for (const m of line.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g)) {
        const rgb = [Number(m[1]), Number(m[2]), Number(m[3])];
        if (spread(rgb) > NEUTRAL_SPREAD) {
          offenders.push(`${file}:${i + 1} → ${m[0]}（请换成 var(--token) 或 color-mix(...)）`);
        }
      }
    });
  }
  assert.deepStrictEqual(
    offenders,
    [],
    '以下位置出现了硬编码色相（配色事实源只能是 theme.css）：\n' + offenders.join('\n'),
  );
});

test('② 两套主题的 token 齐备，且签名色在两套主题下不同', () => {
  const css = stripComments(readFileSync(join(STYLE_DIR, 'theme.css'), 'utf8'));
  /** 取某主题块里的 token 表。 */
  const tokensOf = (themeName: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!m[1].includes(themeName)) continue;
      for (const part of m[2].split(';')) {
        const i = part.indexOf(':');
        if (i < 0) continue;
        const key = part.slice(0, i).trim();
        if (key.startsWith('--')) out[key.slice(2)] = part.slice(i + 1).trim();
      }
    }
    return out;
  };
  const dark = tokensOf('dark');
  const light = tokensOf('light');
  /** 实色 token：必须是 6 位 hex（它们是配色的"出货值"，可被重新计算对比度）。 */
  const required = [
    'bg', 'bg-elev', 'panel', 'panel-2', 'panel-sel', 'code-bg',
    'hairline', 'border-soft', 'border', 'border-strong',
    'text', 'dim', 'faint',
    'accent', 'accent-2', 'ink-fg', 'brand',
    'ok', 'err', 'warn', 'info', 'add', 'del',
    'on-ok', 'on-err', 'toast-ok', 'toast-err',
  ];
  /** 派生 token：由签名色渲染出来的淡底/描边，允许 color-mix（只要定义过且非空）。 */
  const derived = ['accent-soft', 'accent-line'];
  for (const key of required) {
    assert.match(String(dark[key]), /^#[0-9a-f]{6}$/i, `dark 主题缺 token --${key}（或不是 6 位 hex）`);
    assert.match(String(light[key]), /^#[0-9a-f]{6}$/i, `light 主题缺 token --${key}（或不是 6 位 hex）`);
  }
  for (const key of derived) {
    assert.ok(String(dark[key] ?? '').length > 0, `dark 主题缺派生 token --${key}`);
    assert.ok(String(light[key] ?? '').length > 0, `light 主题缺派生 token --${key}`);
  }
  // 签名色必须是两套不同的墨：深色下是浅墨、亮色下是深墨。相同就说明主题没真正分叉。
  assert.notStrictEqual(dark.accent, light.accent, '签名色 --accent 在两套主题下必须不同');
  // 语义色也必须分叉（深色用高明度、亮色用低明度），否则一套主题下必然不达 AA。
  for (const key of ['ok', 'err', 'warn', 'add', 'del']) {
    assert.notStrictEqual(dark[key], light[key], `语义色 --${key} 在两套主题下必须不同`);
  }
});

/**
 * 把 `#rrggbb` 转成浏览器 `rgb(r, g, b)` 的字符串形态，便于与 computedStyle 对比。
 * @param hex token 值
 * @returns 标准化字符串
 */
function asRgb(hex: string): string {
  const rgb = hexToRgb(hex) ?? [0, 0, 0];
  return `rgb(${rgb.join(', ')})`;
}

/**
 * 解析计算后的颜色（`rgb(r, g, b)` 或新版 Chrome 的 `color(srgb r g b)`）。
 * @param value getComputedStyle 返回值
 * @returns [r,g,b]（0–255，浮点）；无法解析为 null
 */
function computedRgb(value: string | null): number[] | null {
  if (value === null) return null;
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(value);
  if (rgb !== null) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  const srgb = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/i.exec(value);
  if (srgb !== null) {
    return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255];
  }
  return null;
}

/**
 * 按 sRGB 线性混合两个 token 的期望值（0–255）。
 * @param base 底色 token
 * @param accent 语义色 token
 * @param ratio 语义色占比（0–1）
 * @returns [r,g,b]
 */
function mixToken(base: string, accent: string, ratio: number): number[] {
  const a = hexToRgb(accent) ?? [0, 0, 0];
  const b = hexToRgb(base) ?? [0, 0, 0];
  return a.map((value, i) => value * ratio + b[i]! * (1 - ratio));
}

test('③ 真机：签名色与语义色的解析值真的落在组件上（两套主题）', { timeout: 120_000 }, async (t) => {
  const page = await openStubSession(t, {
    stub: '_color-system.html',
    width: 1280,
    height: 900,
  });
  if (page === null) return;
  try {
    await new Promise((r) => setTimeout(r, 1200));
    const result = (await page.cdp.evaluate(`(function(){
      // 关掉过渡：主题切换会让 background 走 140ms 的 transition，
      // 切换瞬间读 computedStyle 会拿到"过渡起点"（上一套主题的颜色）⇒ 假红。
      var kill = document.getElementById('__color_probe_style');
      if (kill === null) {
        kill = document.createElement('style');
        kill.id = '__color_probe_style';
        kill.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}';
        document.head.appendChild(kill);
      }
      function probe(theme){
        document.documentElement.setAttribute('data-theme', theme);
        var root = getComputedStyle(document.documentElement);
        var send = document.querySelector('.send.round');
        var host = document.getElementById('__color_probe');
        if (host === null) {
          host = document.createElement('div');
          host.id = '__color_probe';
          host.style.position = 'fixed';
          host.style.left = '-99999px';
          document.body.appendChild(host);
        }
        host.innerHTML = '<div class="change-badge add">x</div><div class="change-badge del">y</div><div class="pill on"><i class="dot"></i></div>';
        var add = getComputedStyle(host.querySelector('.change-badge.add'));
        var del = getComputedStyle(host.querySelector('.change-badge.del'));
        var dot = getComputedStyle(host.querySelector('.pill .dot'));
        var out = {
          theme: theme,
          accent: root.getPropertyValue('--accent').trim(),
          added: add.color,
          deleted: del.color,
          dot: dot.backgroundColor,
          sendBg: send === null ? null : getComputedStyle(send).backgroundColor,
          bodyBg: getComputedStyle(document.body).backgroundColor,
        };
        host.innerHTML = '';
        return out;
      }
      return { dark: probe('dark'), light: probe('light') };
    })()`)) as {
      dark: Record<string, string | null>;
      light: Record<string, string | null>;
    };

    const tokens: Record<string, Record<string, string>> = {};
    const css = stripComments(readFileSync(join(STYLE_DIR, 'theme.css'), 'utf8'));
    for (const themeName of ['dark', 'light']) {
      tokens[themeName] = {};
      for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!m[1].includes(themeName)) continue;
        for (const part of m[2].split(';')) {
          const i = part.indexOf(':');
          if (i >= 0 && part.slice(0, i).trim().startsWith('--')) {
            tokens[themeName][part.slice(0, i).trim().slice(2)] = part.slice(i + 1).trim();
          }
        }
      }
    }

    for (const themeName of ['dark', 'light']) {
      const seen = result[themeName as 'dark' | 'light'];
      const tk = tokens[themeName];
      assert.strictEqual(seen['accent'], tk['accent'], `${themeName}：--accent 未生效`);
      assert.strictEqual(seen['bodyBg'], asRgb(tk['bg']), `${themeName}：body 底色不是 --bg`);
      assert.strictEqual(seen['added'], asRgb(tk['add']), `${themeName}：新增徽标没用 --add`);
      assert.strictEqual(seen['deleted'], asRgb(tk['del']), `${themeName}：删除徽标没用 --del`);
      assert.strictEqual(seen['dot'], asRgb(tk['ok']), `${themeName}：在线状态点没用 --ok`);
      if (seen['sendBg'] !== null) {
        // 2026-10-20 设计：主操作 = 12% 语义色 + 88% panel 的淡底，不再是实心 accent。
        const actual = computedRgb(seen['sendBg']);
        assert.ok(actual !== null, `${themeName}：发送按钮底色无法解析：${seen['sendBg']}`);
        const expected = mixToken(String(tk['panel']), String(tk['accent']), 0.12);
        for (let i = 0; i < 3; i += 1) {
          assert.ok(
            Math.abs(actual[i]! - expected[i]!) <= 1.5,
            `${themeName}：发送按钮底色不是 accent 12% + panel（通道 ${i}: ${String(
              actual[i],
            )} vs ${String(expected[i])}）`,
          );
        }
      }
    }
  } finally {
    await page.close();
  }
});
