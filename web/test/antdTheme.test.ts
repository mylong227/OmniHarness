// 判据：antd 主题接线（W1；数字契约来自 UI_LIBRARY_UPGRADE §0.5 / ADR-0018 §4）。
//
// 四条不变量：
//   ① **单一颜色事实源**：antdTheme.ts 不得出现主题色字面 hex（黑/白混合锚点除外）；
//     palette.ts 是唯一颜色源，theme.css 的同名 token 与它逐值一致（抽样比对）。
//   ② **seed 即 map**：antdThemeOf 必须显式走 defaultAlgorithm——W0 实测 darkAlgorithm
//     会强制压暗语义 seed（#a8b4e8 → #929cc8），打破「主行动 === --accent」契约。
//   ③ **对比度 ≥4.5（文本）/ ≥3（非文本边线）**：contrastPairsOf 的全部配对，
//     两套主题分别断言。
//   ④ **dark 语义 hover/active 显式提亮档**：dark 下 colorPrimaryHover 必须比 base 更亮
//     （暗场里压暗的 hover 不可见）；浅色下不提供（antd 默认压暗方向正确）。

// @vitest-environment jsdom
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

import { antdThemeOf, DENSITY, FONT_FAMILY, mixHex } from '../src/ui/theme/antdTheme.ts';
import { DARK, LIGHT, paletteOf } from '../src/ui/theme/palette.ts';
import { contrastPairsOf, contrastRatio } from '../src/ui/theme/contrast.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

test('① antdTheme.ts 无主题色字面 hex（黑/白混合锚点除外）', () => {
  const src = readFileSync(join(HERE, '../src/ui/theme/antdTheme.ts'), 'utf8');
  // 剥掉注释，避免文档里的示例色值假红。
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const hexes = [...code.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0].toLowerCase());
  const allowed = new Set(['#000000', '#ffffff']);
  const offenders = hexes.filter((h) => !allowed.has(h));
  assert.deepStrictEqual(
    offenders,
    [],
    'antdTheme.ts 出现了主题色字面 hex——颜色必须来自 paletteOf(theme)：\n' + offenders.join('\n'),
  );
});

test('① palette.ts 与 theme.css 的同名 token 逐值一致（抽样）', () => {
  const css = readFileSync(join(HERE, '../styles/theme.css'), 'utf8');
  // 分段解析：dark 段 = `:root, [data-theme='dark']`（文件头），light 段 = `[data-theme='light']` 之后。
  // 不分段会把 dark 值当成 light 值（同名 token 在两段各定义一次）。
  const lightStart = css.indexOf("[data-theme='light']");
  assert.ok(lightStart > 0, 'theme.css 找不到 light 段');
  const sections: Record<'dark' | 'light', Map<string, string>> = {
    dark: new Map<string, string>(),
    light: new Map<string, string>(),
  };
  for (const m of css.matchAll(/^\s*--([a-z0-9-]+):\s*([^;]+);/gim)) {
    const section = m.index !== undefined && m.index >= lightStart ? 'light' : 'dark';
    sections[section].set(m[1], m[2].trim());
  }
  const samples: [theme: 'dark' | 'light', varName: string, value: string][] = [
    ['dark', '--bg', DARK.bg],
    ['dark', '--panel', DARK.panel],
    ['dark', '--accent', DARK.accent],
    ['dark', '--text', DARK.text],
    ['dark', '--ok', DARK.ok],
    ['dark', '--err', DARK.err],
    ['dark', '--tip-bg', DARK.tipBg],
    ['light', '--bg', LIGHT.bg],
    ['light', '--panel', LIGHT.panel],
    ['light', '--accent', LIGHT.accent],
    ['light', '--text', LIGHT.text],
    ['light', '--ok', LIGHT.ok],
    ['light', '--err', LIGHT.err],
    ['light', '--tip-bg', LIGHT.tipBg],
  ];
  const offenders: string[] = [];
  for (const [theme, varName, value] of samples) {
    const cssValue = sections[theme].get(varName.slice(2));
    if (cssValue === undefined) {
      offenders.push(`${theme} ${varName} 在 theme.css 缺失`);
      continue;
    }
    if (cssValue.toLowerCase() !== value.toLowerCase()) {
      offenders.push(`${theme} ${varName}: theme.css=${cssValue} vs palette=${value}`);
    }
  }
  assert.deepStrictEqual(offenders, [], 'palette 与 theme.css 漂移（改一处必须同步另一处）：\n' + offenders.join('\n'));
});

test('② 两套主题都必须显式走 defaultAlgorithm（seed 即 map）', () => {
  for (const theme of ['dark', 'light'] as const) {
    const cfg = antdThemeOf(theme);
    assert.ok(
      !('algorithm' in cfg && Array.isArray(cfg.algorithm)),
      'algorithm 不允许是数组拼接（会重新引入 darkAlgorithm 派生）',
    );
    const token = cfg.token ?? {};
    assert.strictEqual(
      token.colorPrimary,
      paletteOf(theme).accent,
      `${theme}: colorPrimary 必须精确等于 palette accent（W0：darkAlgorithm 压暗已实测）`,
    );
  }
});

test('② cssVar 显式开启且 hashed 关闭（类名稳定 + 变量可判据）', () => {
  for (const theme of ['dark', 'light'] as const) {
    const cfg = antdThemeOf(theme);
    assert.ok(cfg.cssVar, 'cssVar 必须显式开启（W0 实测默认关闭）');
    assert.strictEqual(cfg.hashed, false, 'hashed 必须关闭（判据与覆盖 CSS 依赖稳定类名）');
  }
});

test('② 密度与字体常量与纸与墨口径一致', () => {
  assert.strictEqual(DENSITY.controlHeight, 32);
  assert.strictEqual(DENSITY.controlHeightSM, 28);
  assert.strictEqual(DENSITY.controlHeightLG, 38);
  assert.strictEqual(DENSITY.borderRadius, 10);
  assert.strictEqual(DENSITY.borderRadiusLG, 14);
  assert.strictEqual(DENSITY.borderRadiusSM, 8);
  assert.strictEqual(DENSITY.fontSize, 14);
  assert.strictEqual(FONT_FAMILY, "system-ui, 'Segoe UI', -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif");
});

test('③ 两套主题的全部关键配对达到 WCAG 下限', () => {
  for (const theme of ['dark', 'light'] as const) {
    for (const pair of contrastPairsOf(theme)) {
      const ratio = contrastRatio(pair.fg, pair.bg);
      assert.ok(
        ratio !== null && ratio >= pair.minimum,
        `${theme} ${pair.label}: ${ratio?.toFixed(2) ?? 'NaN'}:1 < ${pair.minimum}:1`,
      );
    }
  }
});

test('④ dark 的语义 hover/active 是显式提亮/压暗档；浅色不提供（antd 默认方向正确）', () => {
  const lum = (hex: string) => contrastRatio(hex, '#000000') ?? 0;
  const dark = antdThemeOf('dark').token ?? {};
  const dp = paletteOf('dark');
  assert.strictEqual(dark.colorPrimaryHover, dp.accent2, 'dark primary hover 必须用 accent2（提亮档）');
  assert.ok(
    lum(String(dark.colorPrimaryHover)) > lum(dp.accent),
    'dark hover 必须比 base 更亮（暗场压暗不可见）',
  );
  assert.ok(
    lum(String(dark.colorPrimaryActive)) < lum(dp.accent),
    'dark active 必须比 base 更暗（按下反馈）',
  );
  const light = antdThemeOf('light').token ?? {};
  assert.strictEqual(light.colorPrimaryHover, undefined, '浅色 hover 交给 antd 默认压暗派生');
});

test('mixHex：端点恒等与中点混合', () => {
  assert.strictEqual(mixHex('#a8b4e8', '#ffffff', 0), '#a8b4e8');
  assert.strictEqual(mixHex('#a8b4e8', '#ffffff', 1), '#ffffff');
  assert.strictEqual(mixHex('#000000', '#ffffff', 0.5), '#808080');
});
