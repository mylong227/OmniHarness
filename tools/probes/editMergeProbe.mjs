#!/usr/bin/env node
/**
 * 并发编辑合并探针（2026-10-30 研究：并发编辑的冲突边界在哪）。
 *
 * ## 回答什么问题
 *
 * 本仓文件写入的现役合并是 `TextThreeWayMerge`（行级 diff3 + 冲突片段字符级细化），
 * 由 `write_file` / `edit` / `apply_patch` 共用，基线来自 `SessionBaselineStore`。
 * 文档长期把「字符级 / OT / CRDT」标为未做——但**没有数字说明现役实现到底在哪些形态上失效**。
 * 本探针就是那份数字：一组确定性场景 × 现役合并器，逐条给出「干净合并 / 冲突 / 放弃」与正确性判定。
 *
 * ## 口径边界（诚实）
 *
 * - 只测 `TextThreeWayMerge.merge`（纯函数、无 IO、无模型），**不测**两个真实会话并发写文件时的
 *   工具层行为（基线读取、哈希闸、落盘顺序）——那是同一研究的下半段，见文档 §4。
 * - 场景是**人工构造的最小形态**，不是真实仓库 diff 的统计分布；它回答「会不会错」，不回答「多常错」。
 *
 * ## 用法
 *
 *   npm run build && node tools/probes/editMergeProbe.mjs
 *   node tools/probes/editMergeProbe.mjs --json   # 机器可读
 *
 * 退出码恒 0（这是研究探针，不是门禁）；判定表打印到 stdout。
 */
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/**
 * 从编译产物导入（与其它探针同一口径：探针不参与 tsc 编译，必须走 dist）。
 * @param segments dist 下的相对路径段
 * @returns 模块
 */
async function loadDist(segments) {
  return import(pathToFileURL(join(ROOT, 'dist', 'src', ...segments)).href);
}

const { TextThreeWayMerge } = await loadDist(['util', 'textThreeWayMerge.js']);

/** 判定孤立代理项（字符级 LCS 若按 UTF-16 码元切，会切坏 emoji）。 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

/**
 * @typedef {object} Scenario
 * @property {string} id 场景 id
 * @property {string} title 一句话说明
 * @property {string} base 共同祖先
 * @property {string} ours 我方
 * @property {string} theirs 对方（磁盘最新）
 * @property {'clean'|'conflict'} expect 设计意图：应当干净合并还是应当冲突
 * @property {string} [want] 期望的合并结果（expect=clean 时用于正确性判定）
 * @property {string} note 为什么这样期望
 */

/** @type {Scenario[]} */
const SCENARIOS = [
  {
    id: 'A-disjoint',
    title: '两侧改不同行',
    base: 'const a = 1;\nconst b = 2;\nconst c = 3;',
    ours: 'const A = 1;\nconst b = 2;\nconst c = 3;',
    theirs: 'const a = 1;\nconst b = 2;\nconst C = 3;',
    expect: 'clean',
    want: 'const A = 1;\nconst b = 2;\nconst C = 3;',
    note: '互不相交的编辑必须都保留',
  },
  {
    id: 'B-same-line',
    title: '同一行改不同词',
    base: 'const x = foo(1);',
    ours: 'const y = foo(1);',
    theirs: 'const x = bar(1);',
    expect: 'clean',
    want: 'const y = bar(1);',
    note: '字符级细化应把同行两处改动都合并',
  },
  {
    id: 'C-same-token',
    title: '同一行的同一个词各改成不同值',
    base: 'const x = 1;',
    ours: 'const x = 2;',
    theirs: 'const x = 3;',
    expect: 'conflict',
    note: '真正的语义冲突：无法自动裁定 2 还是 3',
  },
  {
    id: 'D-delete-vs-edit',
    title: '一侧删行、另一侧改该行',
    base: 'a\nb\nc',
    ours: 'a\nc',
    theirs: 'a\nB\nc',
    expect: 'conflict',
    note: '删与被改不能同时成立，必须让用户裁决',
  },
  {
    id: 'E-both-insert-same-point',
    title: '两侧在同一位置各插一行',
    base: 'a\nb',
    ours: 'a\nX\nb',
    theirs: 'a\nY\nb',
    expect: 'conflict',
    note: '同点双插入无法裁定先后（git diff3 同样报冲突）；<br>若要"都保留"必须显式约定顺序策略',
  },
  {
    id: 'F-crlf-vs-lf',
    title: '一侧 CRLF、另一侧 LF 写回',
    base: 'a\r\nb\r\n',
    ours: 'A\r\nb\r\n',
    theirs: 'a\nB\n',
    expect: 'clean',
    want: 'A\r\nB\r\n',
    note: '行尾风格不同不该被静默改写；结果沿用 base 的 CRLF',
  },
  {
    id: 'F2-mixed-eol',
    title: 'CRLF 文件两侧各改一行（对方整份文件是 LF）',
    base: 'a\r\nb\r\nc\r\n',
    ours: 'A\r\nb\r\nc\r\n',
    theirs: 'a\nb\nC\n',
    expect: 'clean',
    want: 'A\r\nb\r\nC\r\n',
    note: '若真合并，至少要保证**不产出混合行尾**（结果沿用 base 的 CRLF）',
  },
  {
    id: 'F3-genuinely-mixed',
    title: 'base 本身就是混行尾（不替用户改写形状）',
    base: 'a\r\nb\nc\n',
    ours: 'A\r\nb\nc\n',
    theirs: 'a\r\nb\nC\n',
    expect: 'clean',
    want: 'A\r\nb\nC\n',
    note: '混合行尾是作者现状，不得被"顺手统一"',
  },
  {
    id: 'K-both-same',
    title: '两端做了完全相同的修改',
    base: 'const x = 1;',
    ours: 'const x = 2;',
    theirs: 'const x = 2;',
    expect: 'clean',
    want: 'const x = 2;',
    note: '同一改动不算冲突（幂等）',
  },
  {
    id: 'L-adjacent',
    title: '一侧改某行、另一侧紧邻其后插入',
    base: 'a\nb\nc',
    ours: 'a\nB\nc',
    theirs: 'a\nb\nNEW\nc',
    expect: 'clean',
    want: 'a\nB\nNEW\nc',
    note: '边界相接不算相交，两者都能成立',
  },
  {
    id: 'G-emoji-boundary',
    title: '两侧各改 emoji 邻近字符',
    base: '😀 hello',
    ours: '😃 hello',
    theirs: '😀 world',
    expect: 'clean',
    want: '😃 world',
    note: '字符级 LCS 若按码元切，可能产出孤立代理项（乱码）',
  },
  {
    id: 'H-too-large',
    title: '超大文件（超出差分矩阵上限）',
    base: Array.from({ length: 2000 }, (_, i) => `line ${String(i)}`).join('\n'),
    ours: `${Array.from({ length: 2000 }, (_, i) => (i === 1 ? 'LINE 1' : `line ${String(i)}`)).join('\n')}`,
    theirs: `${Array.from({ length: 2000 }, (_, i) => (i === 1998 ? 'LINE 1998' : `line ${String(i)}`)).join('\n')}`,
    expect: 'conflict',
    note: '超限必须显式放弃（reason=too-large），不得输出半成品',
  },
  {
    id: 'I-stale-base',
    title: '磁盘在基线之后被追加+修改过',
    base: 'a\nb',
    ours: 'A\nb',
    theirs: 'a\nB\nc',
    expect: 'clean',
    want: 'A\nB\nc',
    note: '磁盘新增的行与两侧改动都不冲突，应一起保留',
  },
  {
    id: 'J-whitespace',
    title: '一侧只加行尾空格，另一侧改下一行',
    base: 'a\nb',
    ours: 'a \nb',
    theirs: 'a\nB',
    expect: 'clean',
    want: 'a \nB',
    note: '尾随空格是真实编辑，不该被吞掉',
  },
];

/**
 * 跑一条场景并判定。
 * @param {Scenario} s 场景
 * @returns 结果行
 */
function runOne(s) {
  const first = TextThreeWayMerge.merge(s.base, s.ours, s.theirs);
  const second = TextThreeWayMerge.merge(s.base, s.ours, s.theirs);
  const deterministic = JSON.stringify(first) === JSON.stringify(second);
  const ok = first.ok === true;
  const content = ok ? first.content : '';
  const reason = ok ? '' : first.reason;
  let verdict;
  if (s.expect === 'clean') {
    if (!ok) verdict = `✗ 意外冲突(${reason})`;
    else if (content !== s.want) verdict = '✗ 结果不符';
    else verdict = '✓ 干净且正确';
  } else if (ok) {
    verdict = '✗ 该冲突却合成了';
  } else {
    verdict = `✓ 如实拒绝(${reason})`;
  }
  const lone = ok && LONE_SURROGATE.test(content);
  return {
    id: s.id,
    title: s.title,
    expect: s.expect,
    ok,
    reason,
    verdict,
    deterministic,
    lone,
    content,
    conflicts: ok ? 0 : first.conflicts.length,
    note: s.note,
  };
}

const rows = SCENARIOS.map(runOne);
const json = process.argv.includes('--json');
if (json) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  console.log('| 场景 | 期望 | 实际 | 判定 | 确定 | 备注 |');
  console.log('| --- | --- | --- | --- | --- | --- |');
  for (const r of rows) {
    const actual = r.ok ? '干净合并' : `拒绝(${r.reason})`;
    const notes = [
      r.deterministic ? '' : '非确定性',
      r.lone ? '含孤立代理项' : '',
      r.ok && r.conflicts > 0 ? '' : '',
    ]
      .filter((x) => x !== '')
      .join('；');
    console.log(
      `| ${r.id} ${r.title} | ${r.expect === 'clean' ? '干净' : '冲突'} | ${actual} | ${r.verdict} | ${r.deterministic ? '是' : '否'} | ${notes || r.note} |`,
    );
  }
  const bad = rows.filter((r) => r.verdict.startsWith('✗'));
  const lone = rows.filter((r) => r.lone);
  console.log('');
  console.log(
    `合计 ${String(rows.length)} 个场景：正确 ${String(rows.length - bad.length)}，异常 ${String(bad.length)}，孤立代理项 ${String(lone.length)}`,
  );
  if (bad.length > 0) {
    console.log('异常场景：');
    for (const r of bad) {
      console.log(`  - ${r.id}：${r.verdict} ⇒ ${JSON.stringify(r.content).slice(0, 160)}`);
    }
  }
}
