// 语法高亮分色判据（2026-10-31，用户口径：要 VS Code / 主流编辑器那样的多色代码）。
//
// ## 背景
//
// 2026-10-17 曾是「单色体系」（明度+字形），2026-10-31 按用户要求改为 VS Code 风格分色。
// 色相事实源 = theme.css 的 `--tok-*`（colorSystem 门禁禁止 theme.css 之外出现色相字面量），
// highlight.css 只留消费规则。本文件守两条不变量：
//
//   ① **静态对齐**：`highlight.ts` 的 CLS 表（token → class）与 `highlight.css` 的 `.tok-*`
//      选择器一一对应。这是 2026-10-17 真实缺陷的直接回归判据——当时两表名字漂移
//      （tok-cmt vs tok-com），注释/类型/正文三类**静默丢了颜色**，不报错、只少一层色。
//   ② **真机分色**：真 Chrome 里打开一份代码文件，逐类断言 computed color
//      （a）等于 theme.css `--tok-*` 的解析值（类名/变量名改坏 → 回落继承色，立刻红）；
//      （b）真的带色相（RGB 通道极差 > 24，灰色回落逃不掉）；（c）各类颜色互不相同
//      （分色不是「全部染成同一个颜色」）。dark / light 两套主题各跑一遍。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { openStubSession, stubHtmlCdp, type CdpSession } from './browserHarness.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 夹具代码：九类 token 里能被 ts 分词产出的七类都齐（kw/fn/num/str/com/type/plain）。 */
const TS_FIXTURE = [
  'const rate = 0.25; // 速率注释',
  'export function step(n: number): Promise<string> {',
  '  const label = "step";',
  '  return label.repeat(n);',
  '}',
  '',
].join('\n');

function stubWithTsFile() {
  const overrides = {
    'fs.list': {
      tree: [
        {
          name: 'web',
          path: 'web',
          type: 'dir',
          children: [{ name: 'sample.ts', path: 'web/sample.ts', type: 'file' }],
        },
      ],
    },
    'fs.read': { path: 'web/sample.ts', content: TS_FIXTURE },
  };
  return stubHtmlCdp().replace(
    '<div id="root"></div>',
    '<div id="root"></div>\n<script>window.__RPC_OVERRIDES__ = ' +
      JSON.stringify(overrides) +
      ';</script>',
  );
}

test('① CLS 表与 highlight.css 的 .tok-* 选择器一一对应', () => {
  const ts = readFileSync(join(HERE, '../src/ui/highlight.ts'), 'utf8');
  const css = readFileSync(join(HERE, '../styles/highlight.css'), 'utf8');
  const clsBlock = /const CLS: Record<Tok\['t'\], string> = \{([\s\S]*?)\};/.exec(ts);
  assert.ok(clsBlock, 'highlight.ts 里找不到 CLS 表（结构变了就同步本判据）');
  const fromTs = new Set([...clsBlock[1].matchAll(/'tok-([\w-]+)'/g)].map((m) => m[1]));
  const fromCss = new Set([...css.matchAll(/\.tok-([\w-]+)/g)].map((m) => m[1]));
  assert.ok(fromTs.size > 0 && fromCss.size > 0, '两表任一为空，判据失去意义');
  for (const name of fromTs) {
    assert.ok(fromCss.has(name), `CLS 表里的 .tok-${name} 在 highlight.css 没有对应规则（颜色会静默丢失）`);
  }
  for (const name of fromCss) {
    assert.ok(fromTs.has(name), `highlight.css 的 .tok-${name} 在 CLS 表里没有生产者（死规则）`);
  }
});

/** 量一次各 token 类的 computed color（CSS 像素口径下 rgb 字符串 + 期望 hex）。 */
interface TokenColor {
  /** 类名（tok-kw 等）。 */
  cls: string;
  /** 对应的 theme.css 变量名——类名与变量名**不同名**（tok-str↔--tok-string、tok-com↔--tok-comment）。 */
  varName: string;
  /** 该类首个 span 是否存在于 DOM。 */
  found: boolean;
  /** computed color（'rgb(r, g, b)'）。 */
  computed: string;
  /** theme.css 里该变量的原始值（hex）。 */
  expected: string;
}

/** 类名 → theme.css 变量名（不同名的三处在此显式声明，别用类名推导）。 */
const CLASS_TO_VAR: Record<string, string> = {
  'tok-kw': '--tok-kw',
  'tok-fn': '--tok-fn',
  'tok-num': '--tok-num',
  'tok-str': '--tok-string',
  'tok-com': '--tok-comment',
  'tok-type': '--tok-type',
  'tok-plain': '--tok-plain',
};

/**
 * 在页面里量各 token 类的颜色。
 * @param cdp CDP 会话
 * @returns 每类一条记录；找不到 .hl-code 时 null
 */
async function readTokenColors(cdp: CdpSession): Promise<TokenColor[] | null> {
  const pairs = JSON.stringify(CLASS_TO_VAR);
  const raw = (await cdp.evaluate(`(function(){
    var pre = document.querySelector('.code-scroll .hl-code');
    if (!pre) return null;
    var root = document.documentElement;
    var PAIRS = ${pairs};
    function hexToRgbStr(hex) {
      var m = /^#([0-9a-fA-F]{6})$/.exec((hex || '').trim());
      if (!m) return '';
      var n = m[1];
      return 'rgb(' + parseInt(n.slice(0,2),16) + ', ' + parseInt(n.slice(2,4),16) + ', ' + parseInt(n.slice(4,6),16) + ')';
    }
    return Object.keys(PAIRS).map(function(c){
      var el = pre.querySelector('.' + c);
      return {
        cls: c,
        varName: PAIRS[c],
        found: !!el,
        computed: el ? getComputedStyle(el).color : '',
        expected: hexToRgbStr(getComputedStyle(root).getPropertyValue(PAIRS[c]))
      };
    });
  })()`)) as TokenColor[] | null;
  return raw;
}

/** RGB 通道极差（>24 即「带色相」，colorSystem 门禁同口径）。 */
function spreadOf(rgb: string): number {
  const m = /rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/.exec(rgb);
  if (!m) return -1;
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return Math.max(r, g, b) - Math.min(r, g, b);
}

for (const theme of ['dark', 'light'] as const) {
  test(`② 真机分色：${theme} 主题下各类 token 吃到 theme.css 的色相且互不相同`, { timeout: 120_000 }, async (t) => {
    const page = await openStubSession(t, {
      width: 1600,
      height: 1000,
      html: stubWithTsFile(),
    });
    if (page === null) return;
    try {
      const { cdp } = page;
      if (theme === 'light') {
        await cdp.evaluate("document.documentElement.dataset.theme = 'light'; true");
      }
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
      assert.strictEqual(await clickTree('sample.ts'), true, '打不开 sample.ts');
      assert.ok(await cdp.waitFor("!!document.querySelector('.code-scroll .hl-code .tok-kw')", 3000), '高亮正文没有渲染');

      const colors = await readTokenColors(cdp);
      assert.ok(colors !== null, '量不到 token 颜色');
      // 夹具自洽：夹具代码必须真的产出全部七类，否则判据在量空集。
      for (const c of colors) {
        assert.ok(c.found, `夹具没有产出 .${c.cls}（判据失去意义，补夹具）`);
      }
      const violations: string[] = [];
      for (const c of colors) {
        if (c.expected === '') {
          violations.push(`.${c.cls}：theme.css 缺 ${c.varName} 变量`);
          continue;
        }
        if (c.computed.toLowerCase() !== c.expected.toLowerCase()) {
          violations.push(`.${c.cls}：computed=${c.computed} ≠ --tok-*=${c.expected}（类名或变量名漂移）`);
        }
      }
      // 带色相：六个「该有颜色」的类不允许退化成灰（inherit 回落 / 变量缺失都会变灰）。
      for (const c of colors) {
        if (c.cls === 'tok-plain') continue;
        const sp = spreadOf(c.computed);
        if (sp <= 24) {
          violations.push(`.${c.cls}：没有色相（spread=${String(sp)}，computed=${c.computed}，疑似回落继承色）`);
        }
      }
      // 分色：六个彩色类互不相同（≥5 个不同值即分色成立）。
      const distinct = new Set(colors.filter((c) => c.cls !== 'tok-plain').map((c) => c.computed.toLowerCase()));
      if (distinct.size < 5) {
        violations.push(`分色失效：六个彩色类只有 ${String(distinct.size)} 种颜色（${[...distinct].join(' / ')}）`);
      }
      assert.deepStrictEqual(violations, [], `${theme} 主题语法分色不合格`);
    } finally {
      await page.close();
    }
  });
}
