// AST-based standards audit using the TypeScript compiler API.
// Measures each src/*.ts file against the 8 new code standards precisely.
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { execSync } from 'node:child_process';

const root = 'src';
const HOT = new Set([
  'src/core/stepRunner.ts',
  'src/core/turnRunner.ts',
  'src/ports/toolInputSink.ts',
]);
const isHot = (f) =>
  f.split(path.sep).join('/').startsWith('src/adapters/live/') ||
  HOT.has(f.split(path.sep).join('/'));

const files = [];
function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) {
      if (['tests', 'node_modules', 'dist'].includes(e.name)) continue;
      walk(p);
    } else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) files.push(p);
  }
}
walk(root);

// ---- import graph (fan-in) ----
function key(f) {
  return f
    .split(path.sep)
    .join('/')
    .replace(/^src\//, '')
    .replace(/\.ts$/, '');
}
const fanIn = new Map();
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const re = /(?:from\s+|import\s*\(\s*)(['"])([^'"]+)\1/g;
  let m;
  while ((m = re.exec(src))) {
    let spec = m[2];
    if (!spec.startsWith('.')) continue;
    let resolved = path.posix.normalize(path.posix.join(path.posix.dirname(key(f)), spec));
    resolved = resolved.replace(/\.js$/, '').replace(/\/index$/, '');
    fanIn.set(resolved, (fanIn.get(resolved) || 0) + 1);
  }
}

const hasJsDoc = (node, sf) => {
  const ranges = ts.getLeadingCommentRanges(sf.text, node.pos) || [];
  return ranges.some((r) => sf.text.slice(r.pos, r.pos + 3) === '/**');
};

/**
 * 对单份源码文本计算标准度量（不依赖文件 IO，供全量扫描与 `--delta` 增量对比复用）。
 *
 * @param text 源码文本
 * @param fileName 文件名（用于「主类名 ↔ 文件名」匹配）
 * @returns 该文件的度量对象（行数、var/any 计数、类清单、公开成员 JSDoc 缺口、上帝类判定等）
 */
function metricsForSource(text, fileName) {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const base = path.basename(fileName).replace(/\.ts$/, '');
  const lines = text.split('\n').length;
  let varCount = 0,
    anyCount = 0,
    classes = [],
    topFns = [],
    staticCount = 0;
  let expFnsNoJsdoc = 0,
    expFnsNoRet = 0;
  const missingJsdoc = [];
  let membersNoAccess = 0,
    membersTotal = 0,
    publicNoJsdoc = 0,
    publicTotal = 0;
  const exportedClasses = [];

  const visit = (node) => {
    if (ts.isVariableStatement(node)) {
      if (
        (node.declarationList.flags & ts.NodeFlags.Let) === 0 &&
        (node.declarationList.flags & ts.NodeFlags.Const) === 0
      )
        varCount++;
    }
    if (node.kind === ts.SyntaxKind.AnyKeyword) anyCount++;
    if (ts.isFunctionDeclaration(node)) {
      const name = node.name ? node.name.text : '(anonymous)';
      const exported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      topFns.push({ name, exported: !!exported, jsdoc: hasJsDoc(node, sf), ret: !!node.type });
      if (exported) {
        if (!hasJsDoc(node, sf)) expFnsNoJsdoc++;
        if (!node.type) expFnsNoRet++;
      }
    }
    if (ts.isClassDeclaration(node)) {
      const cname = node.name ? node.name.text : '(anonymous)';
      const exported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      let methods = 0;
      for (const mem of node.members) {
        membersTotal++;
        const mods = mem.modifiers || [];
        const hasAccess = mods.some((m) =>
          [
            ts.SyntaxKind.PublicKeyword,
            ts.SyntaxKind.PrivateKeyword,
            ts.SyntaxKind.ProtectedKeyword,
          ].includes(m.kind),
        );
        const isStatic = mods.some((m) => m.kind === ts.SyntaxKind.StaticKeyword);
        if (isStatic) staticCount++;
        if (ts.isMethodDeclaration(mem) || ts.isPropertyDeclaration(mem)) {
          methods++;
          if (!hasAccess) membersNoAccess++;
          // public = explicit public OR no access modifier (default public)
          const isPrivate = mods.some((m) =>
            [ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword].includes(m.kind),
          );
          if (!isPrivate) {
            publicTotal++;
            if (!hasJsDoc(mem, sf)) {
              publicNoJsdoc++;
              const nm = mem.name ? mem.name.getText(sf) : '(ctor)';
              missingJsdoc.push({
                name: nm,
                line: sf.getLineAndCharacterOfPosition(mem.getStart()).line + 1,
              });
            }
          }
        } else if (!hasAccess) membersNoAccess++;
      }
      classes.push({ name: cname, methods, exported: !!exported, jsdoc: hasJsDoc(node, sf) });
      if (exported) exportedClasses.push(cname);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  const mainClass = classes.find((c) => c.exported)?.name;
  const nameMatches = mainClass
    ? mainClass.toLowerCase() === base.toLowerCase() ||
      mainClass.toLowerCase().replace(/[^a-z]/g, '') === base.toLowerCase().replace(/[^a-z]/g, '')
    : true;
  const maxMethods = Math.max(0, ...classes.map((c) => c.methods));
  // 口径（2026-09-12 修正）：「上帝类」是**类**的属性，故只统计**含类**的文件；
  // 无类的纯函数模块按 check.mjs 的 800 行文件上限判定，不在此重复计数。
  const godClass = classes.length > 0 && (lines > 500 || maxMethods > 25);
  return {
    file: fileName,
    lines,
    varCount,
    anyCount,
    classes,
    topFns,
    staticCount,
    expFnsNoJsdoc,
    expFnsNoRet,
    membersNoAccess,
    membersTotal,
    publicNoJsdoc,
    publicTotal,
    mainClass,
    nameMatches,
    missingJsdoc,
    godClass,
    exportedCount: exportedClasses.length,
  };
}

const report = [];
for (const f of files) {
  const m = metricsForSource(fs.readFileSync(f, 'utf8'), f);
  m.fanIn = fanIn.get(key(f)) || 0;
  m.hot = isHot(f);
  report.push(m);
}

if (process.argv.includes('--delta')) {
  // 增量门禁（pre-commit 用）：仅阻断**本次提交新增**的标准违规，不阻挡历史债务。
  // 口径：对每个暂存 .ts，比较「暂存版本」与「HEAD 版本」的标准度量；
  // 暂存版违规数 > HEAD 版（或新文件存在任何违规）即判失败。
  const staged = [];
  try {
    const out = execSync('git diff --cached --name-only --diff-filter=ACMR -- "*.ts"', {
      encoding: 'utf8',
    });
    for (const line of out.split('\n')) {
      const f = line.trim();
      if (f && /\.ts$/.test(f) && !f.endsWith('.d.ts')) staged.push(f);
    }
  } catch {
    console.error('[delta] 无法获取暂存文件（非 git 环境？），跳过增量门禁。');
    process.exit(0);
  }
  if (staged.length === 0) {
    console.log('[delta] 无暂存 .ts 文件，增量门禁通过。');
    process.exit(0);
  }
  const readGit = (revFile) => {
    try {
      return execSync(`git show ${revFile}`, { encoding: 'utf8' });
    } catch {
      return '';
    }
  };
  const failures = [];
  for (const f of staged) {
    const abs = path.resolve(process.cwd(), f);
    if (!fs.existsSync(abs)) continue; // 删除文件：无新增违规
    const stagedText = readGit(`:${f}`) || fs.readFileSync(abs, 'utf8');
    const headText = readGit(`HEAD:${f}`);
    if (isHot(abs)) continue; // 热区豁免（与全量审计一致）
    const s = metricsForSource(stagedText, abs);
    const h = headText ? metricsForSource(headText, abs) : null;
    const isNew = !h;
    const cmp = (item, sv, hv, detail) => {
      if (isNew) {
        if (sv > 0) failures.push({ f, item, detail: `新文件存在 ${sv} 处（${detail}）` });
      } else if (sv > hv) {
        failures.push({ f, item, detail: `HEAD ${hv} → 暂存 ${sv}（${detail}）` });
      }
    };
    cmp('var', s.varCount, h?.varCount ?? 0, 'var 声明');
    cmp('any', s.anyCount, h?.anyCount ?? 0, 'any 类型');
    cmp(
      '隐式访问修饰符',
      s.membersNoAccess,
      h?.membersNoAccess ?? 0,
      '缺 public/private/protected',
    );
    cmp('公开成员缺JSDoc', s.publicNoJsdoc, h?.publicNoJsdoc ?? 0, '缺 /** */');
    cmp('导出函数缺JSDoc', s.expFnsNoJsdoc, h?.expFnsNoJsdoc ?? 0, '缺 /** */');
    cmp('导出函数缺返回类型', s.expFnsNoRet, h?.expFnsNoRet ?? 0, '缺 : Type');
    if (!s.nameMatches && (isNew || h?.nameMatches)) {
      failures.push({ f, item: '文件名≠类名', detail: `主类 ${s.mainClass}` });
    }
    if (s.godClass && (isNew || !h?.godClass)) {
      const mm = Math.max(0, ...s.classes.map((c) => c.methods));
      failures.push({ f, item: '上帝类', detail: `${s.lines} 行 / ${mm} 方法` });
    }
  }
  if (failures.length > 0) {
    console.error('\n❌ 编码标准增量门禁失败（' + failures.length + ' 处新增违规）：');
    for (const b of failures) console.error(`  - ${b.f}: [${b.item}] ${b.detail}`);
    console.error(
      '\n  本门禁只阻断「本次提交新增」的违规，不阻挡既有历史债务；请就地修掉上述项后再提交。',
    );
    process.exit(1);
  } else {
    console.log('✅ 编码标准增量门禁通过：本次提交未新增标准违规。');
    process.exit(0);
  }
}

const uniq = (a) => [...new Set(a)];
const sum = (a, k) => a.reduce((s, x) => s + x[k], 0);

console.log('=== SUMMARY (' + report.length + ' files) ===');
console.log(
  'var: ' +
    sum(report, 'varCount') +
    '   any: ' +
    sum(report, 'anyCount') +
    '   static: ' +
    sum(report, 'staticCount'),
);
const totalTopFns = report.reduce((s, r) => s + r.topFns.length, 0);
const totalExportedFns = report.reduce((s, r) => s + r.topFns.filter((x) => x.exported).length, 0);
const fnsNoJsdoc = report.reduce(
  (s, r) => s + r.topFns.filter((x) => x.exported && !x.jsdoc).length,
  0,
);
const fnsNoRet = report.reduce(
  (s, r) => s + r.topFns.filter((x) => x.exported && !x.ret).length,
  0,
);
console.log(
  'top-level fns: ' +
    totalTopFns +
    ' (exported ' +
    totalExportedFns +
    ', exported w/o JSDoc ' +
    fnsNoJsdoc +
    ', exported w/o return type ' +
    fnsNoRet +
    ')',
);
console.log(
  'class members w/o explicit access modifier: ' +
    sum(report, 'membersNoAccess') +
    ' / ' +
    sum(report, 'membersTotal'),
);
console.log(
  'public members w/o JSDoc: ' + sum(report, 'publicNoJsdoc') + ' / ' + sum(report, 'publicTotal'),
);

// 口径（2026-09-12 修正）：「上帝类」是**类**的属性，故只统计**含类**的文件。
// 无类的纯函数模块按 check.mjs 的文件上限（800 行，决策 D1）判定，不在此重复计数——
// 否则「一文件一类」达标、函数范式的模块会被误报成上帝类（实测已误报 layeredCodeGraph）。
console.log('\n=== GOD CLASSES (含类文件 >500 lines OR class >25 methods) ===');
let classlessLong = 0;
for (const r of report.slice().sort((a, b) => b.lines - a.lines)) {
  const maxM = Math.max(0, ...r.classes.map((c) => c.methods));
  if (r.classes.length === 0) {
    if (r.lines > 500) classlessLong += 1; // 仅计数，不属「上帝类」
    continue;
  }
  if (r.lines > 500 || maxM > 25)
    console.log(
      r.lines +
        ' lines / ' +
        maxM +
        ' max-methods / ' +
        r.classes.length +
        ' class  ' +
        (r.hot ? '[HOT] ' : '') +
        r.file,
    );
}
if (classlessLong > 0)
  console.log(
    '(' + classlessLong + ' 个 >500 行的**无类**模块已按 D1 的 800 行上限口径排除，不计为上帝类)',
  );

console.log(
  '\n=== FILES WHERE MAIN CLASS NAME != FILENAME (' +
    report.filter((r) => !r.nameMatches).length +
    ') ===',
);
for (const r of report.filter((r) => !r.nameMatches))
  console.log(r.mainClass + '  <->  ' + r.file + (r.hot ? '  [HOT]' : ''));

console.log('\n=== STATIC HEAVY (>=4 statics) ===');
for (const r of report
  .slice()
  .sort((a, b) => b.staticCount - a.staticCount)
  .filter((r) => r.staticCount >= 4))
  console.log(r.staticCount + ' static  ' + r.file + (r.hot ? '  [HOT]' : ''));

console.log('\n=== HIGH FAN-IN (>8 importers) TOP 30 ===');
for (const r of report
  .slice()
  .sort((a, b) => b.fanIn - a.fanIn)
  .slice(0, 30))
  console.log(r.fanIn + ' importers  ' + r.file);

console.log('\n=== MULTI-EXPORT MODULES (>=3 exported classes, one-class-per-file candidates) ===');
for (const r of report.filter((r) => r.classes.filter((c) => c.exported).length >= 3))
  console.log(
    r.classes
      .filter((c) => c.exported)
      .map((c) => c.name)
      .join(',') +
      '  ->  ' +
      r.file,
  );

if (process.argv.includes('--jsdoc')) {
  const ranked = report
    .filter((r) => r.missingJsdoc.length > 0 && !r.hot)
    .sort((a, b) => b.missingJsdoc.length - a.missingJsdoc.length);
  console.log('\n=== MISSING JSDoc ON PUBLIC MEMBERS (per file, top 40) ===');
  for (const r of ranked.slice(0, 40)) {
    console.log(
      r.missingJsdoc.length +
        '  ' +
        r.file +
        '   [' +
        r.missingJsdoc.map((m) => m.name).join(', ') +
        ']',
    );
  }
}

if (process.argv.includes('--maturity')) {
  // T0 · 成熟度治理门禁（docs/TECH_DIRECTION_SYNTHESIS_2026-09-12.md）。
  // 契约：@maturity L0|L1|L2|L3 — <判据>   +   @maturityEvidence <测试文件>（L2/L3 必填且须存在）。
  // 目的：把「命名好听」与「有机制/有定理」机械分开——声称 L2/L3 却无测试者，一律阻断。
  const LEVELS = ['L0', 'L1', 'L2', 'L3'];
  const decls = [];
  const bad = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    const lm = text.match(/@maturity\s+([A-Za-z0-9]+)\s*(?:[—-]\s*(.*))?/);
    if (!lm) continue;
    const level = lm[1];
    const note = (lm[2] ?? '').trim();
    const em = text.match(/@maturityEvidence\s+(\S+)/);
    const evidence = em ? em[1] : null;
    const file = f.split(path.sep).join('/');
    const rec = { file, level, note, evidence };
    decls.push(rec);
    if (!LEVELS.includes(level)) {
      bad.push({ ...rec, why: `等级 '${level}' 非法（须为 ${LEVELS.join('/')}）` });
    } else if ((level === 'L2' || level === 'L3') && !evidence) {
      bad.push({
        ...rec,
        why: `${level} 必须提供 @maturityEvidence 指向测试文件（无测试的声明一律降级）`,
      });
    } else if (evidence && !fs.existsSync(path.resolve(process.cwd(), evidence))) {
      bad.push({ ...rec, why: `证据文件不存在：${evidence}` });
    }
  }

  const byLevel = {};
  for (const d of decls) (byLevel[d.level] ??= []).push(d);
  console.log('\n=== MATURITY DECLARATIONS (' + decls.length + ' 个引擎已声明) ===');
  for (const lv of LEVELS) {
    const list = byLevel[lv] ?? [];
    console.log(`  ${lv}: ${list.length}`);
    for (const d of list) console.log(`      ${d.file}${d.evidence ? '   <- ' + d.evidence : ''}`);
  }
  // 报告级：证据是否「名义的」（测试文件未真正 import 该模块，仅提及名字）。
  // 例：`const bm25 = [{id:'b'}]` 这种桩数据也会命中名字，但不构成覆盖。
  const nominal = decls.filter((d) => {
    if (!d.evidence) return false;
    const p = path.resolve(process.cwd(), d.evidence);
    if (!fs.existsSync(p)) return false;
    const base = path.basename(d.file).replace(/\.ts$/, '');
    const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const text = fs.readFileSync(p, 'utf8');
    if (new RegExp(`${esc}\\.js`).test(text)) return false; // 直接 import 了本模块
    // 经 re-export 导入也算覆盖（如测试 import 适配器，适配器再 `export { X } from './x.js'`）。
    const reExportOf = new RegExp(`export\\s*\\{[^}]*\\}\\s*from\\s*['"][^'"]*${esc}\\.js['"]`);
    const specRe = /from\s+['"]([^'"]+\.js)['"]/g;
    let m;
    while ((m = specRe.exec(text)) !== null) {
      // 测试按 ESM 规范 import '.js'，磁盘上实际是 '.ts'——解析后须换后缀才能命中。
      const target = path.resolve(path.dirname(p), m[1]).replace(/\.js$/, '.ts');
      if (!fs.existsSync(target)) continue;
      if (reExportOf.test(fs.readFileSync(target, 'utf8'))) return false;
    }
    return true;
  });
  if (nominal.length > 0) {
    console.log('\n--- 名义证据（测试文件未出现引擎名，建议人工确认）---');
    for (const d of nominal) console.log(`  ${d.file}  <-  ${d.evidence}`);
  }

  if (bad.length > 0) {
    console.error('\n❌ 成熟度门禁失败（' + bad.length + ' 处）：');
    for (const b of bad) console.error(`  - ${b.file}: ${b.why}`);
    process.exitCode = 1;
  } else {
    console.log('\n✅ 成熟度门禁通过：' + decls.length + ' 项声明，L2/L3 均有存在性证据。');
  }
}

if (process.argv.includes('--html')) {
  console.log('\n=== HOT-ZONE EXEMPT MEMBERS ONLY (should be the residual) ===');
  for (const r of report.filter((x) => x.hot && x.membersNoAccess > 0))
    console.log(r.membersNoAccess + '  ' + r.file);
}

console.log('\n=== LOW-FAN-IN NON-HOT FILES (fanIn<=1, safe first batch) ===');
for (const r of report.filter((r) => !r.hot && r.fanIn <= 1).sort((a, b) => a.lines - b.lines))
  console.log('lines ' + r.lines + ' fanIn ' + r.fanIn + '  ' + r.file);
