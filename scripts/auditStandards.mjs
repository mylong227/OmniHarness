// AST-based standards audit using the TypeScript compiler API.
// Measures each src/*.ts file against the 8 new code standards precisely.
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = 'src';
const HOT = new Set([
  'src/core/stepRunner.ts',
  'src/core/turnRunner.ts',
  'src/ports/toolInputSink.ts',
]);
const isHot = (f) => f.split(path.sep).join('/').startsWith('src/adapters/live/') || HOT.has(f.split(path.sep).join('/'));

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
function key(f) { return f.split(path.sep).join('/').replace(/^src\//, '').replace(/\.ts$/, ''); }
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

const report = [];
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  const sf = ts.createSourceFile(f, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const base = path.basename(f).replace(/\.ts$/, '');
  const lines = text.split('\n').length;

  let varCount = 0, anyCount = 0, classes = [], topFns = [], staticCount = 0;
  const missingJsdoc = [];
  let membersNoAccess = 0, membersTotal = 0, publicNoJsdoc = 0, publicTotal = 0;
  const exportedClasses = [];

  const visit = (node) => {
    if (ts.isVariableStatement(node)) {
      if ((node.declarationList.flags & ts.NodeFlags.Let) === 0 && (node.declarationList.flags & ts.NodeFlags.Const) === 0) varCount++;
    }
    if (node.kind === ts.SyntaxKind.AnyKeyword) anyCount++;
    if (ts.isFunctionDeclaration(node)) {
      const name = node.name ? node.name.text : '(anonymous)';
      const exported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      topFns.push({ name, exported: !!exported, jsdoc: hasJsDoc(node, sf), ret: !!node.type });
    }
    if (ts.isClassDeclaration(node)) {
      const cname = node.name ? node.name.text : '(anonymous)';
      const exported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      let methods = 0;
      for (const mem of node.members) {
        membersTotal++;
        const mods = mem.modifiers || [];
        const hasAccess = mods.some((m) => [ts.SyntaxKind.PublicKeyword, ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword].includes(m.kind));
        const isStatic = mods.some((m) => m.kind === ts.SyntaxKind.StaticKeyword);
        if (isStatic) staticCount++;
        if (ts.isMethodDeclaration(mem) || ts.isPropertyDeclaration(mem)) {
          methods++;
          if (!hasAccess) membersNoAccess++;
          // public = explicit public OR no access modifier (default public)
          const isPrivate = mods.some((m) => [ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword].includes(m.kind));
          if (!isPrivate) {
            publicTotal++;
            if (!hasJsDoc(mem, sf)) {
              publicNoJsdoc++;
              const nm = mem.name ? mem.name.getText(sf) : '(ctor)';
              missingJsdoc.push({ name: nm, line: sf.getLineAndCharacterOfPosition(mem.getStart()).line + 1 });
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

  const fkey = key(f);
  const mainClass = classes.find((c) => c.exported)?.name;
  const nameMatches = mainClass ? (mainClass.toLowerCase() === base.toLowerCase() || mainClass.toLowerCase().replace(/[^a-z]/g, '') === base.toLowerCase().replace(/[^a-z]/g, '')) : true;

  report.push({
    file: fkey, lines, varCount, anyCount, fanIn: fanIn.get(fkey) || 0,
    classes, topFns, staticCount, membersNoAccess, membersTotal, publicNoJsdoc, publicTotal,
    mainClass, nameMatches, hot: isHot(f),
    exportedCount: exportedClasses.length, missingJsdoc,
  });
}

const uniq = (a) => [...new Set(a)];
const sum = (a, k) => a.reduce((s, x) => s + x[k], 0);

console.log('=== SUMMARY (' + report.length + ' files) ===');
console.log('var: ' + sum(report, 'varCount') + '   any: ' + sum(report, 'anyCount') + '   static: ' + sum(report, 'staticCount'));
const totalTopFns = report.reduce((s, r) => s + r.topFns.length, 0);
const totalExportedFns = report.reduce((s, r) => s + r.topFns.filter(x=>x.exported).length, 0);
const fnsNoJsdoc = report.reduce((s, r) => s + r.topFns.filter(x=>x.exported && !x.jsdoc).length, 0);
const fnsNoRet = report.reduce((s, r) => s + r.topFns.filter(x=>x.exported && !x.ret).length, 0);
console.log('top-level fns: ' + totalTopFns + ' (exported ' + totalExportedFns + ', exported w/o JSDoc ' + fnsNoJsdoc + ', exported w/o return type ' + fnsNoRet + ')');
console.log('class members w/o explicit access modifier: ' + sum(report, 'membersNoAccess') + ' / ' + sum(report, 'membersTotal'));
console.log('public members w/o JSDoc: ' + sum(report, 'publicNoJsdoc') + ' / ' + sum(report, 'publicTotal'));

console.log('\n=== GOD CLASSES (file >500 lines OR class >25 methods) ===');
for (const r of report.slice().sort((a,b)=>b.lines-a.lines)) {
  const maxM = Math.max(0, ...r.classes.map(c=>c.methods));
  if (r.lines > 500 || maxM > 25) console.log(r.lines + ' lines / ' + maxM + ' max-methods / ' + r.classes.length + ' class  ' + (r.hot?'[HOT] ':'') + r.file);
}

console.log('\n=== FILES WHERE MAIN CLASS NAME != FILENAME (' + report.filter(r=>!r.nameMatches).length + ') ===');
for (const r of report.filter(r=>!r.nameMatches)) console.log(r.mainClass + '  <->  ' + r.file + (r.hot?'  [HOT]':''));

console.log('\n=== STATIC HEAVY (>=4 statics) ===');
for (const r of report.slice().sort((a,b)=>b.staticCount-a.staticCount).filter(r=>r.staticCount>=4)) console.log(r.staticCount + ' static  ' + r.file + (r.hot?'  [HOT]':''));

console.log('\n=== HIGH FAN-IN (>8 importers) TOP 30 ===');
for (const r of report.slice().sort((a,b)=>b.fanIn-a.fanIn).slice(0,30)) console.log(r.fanIn + ' importers  ' + r.file);

console.log('\n=== MULTI-EXPORT MODULES (>=3 exported classes, one-class-per-file candidates) ===');
for (const r of report.filter(r=>r.classes.filter(c=>c.exported).length>=3)) console.log(r.classes.filter(c=>c.exported).map(c=>c.name).join(',') + '  ->  ' + r.file);

if (process.argv.includes('--jsdoc')) {
  const ranked = report
    .filter((r) => r.missingJsdoc.length > 0 && !r.hot)
    .sort((a, b) => b.missingJsdoc.length - a.missingJsdoc.length);
  console.log('\n=== MISSING JSDoc ON PUBLIC MEMBERS (per file, top 40) ===');
  for (const r of ranked.slice(0, 40)) {
    console.log(r.missingJsdoc.length + '  ' + r.file + '   [' + r.missingJsdoc.map((m) => m.name).join(', ') + ']');
  }
}

if (process.argv.includes('--html')) {
  console.log('\n=== HOT-ZONE EXEMPT MEMBERS ONLY (should be the residual) ===');
  for (const r of report.filter((x) => x.hot && x.membersNoAccess > 0)) console.log(r.membersNoAccess + '  ' + r.file);
}

console.log('\n=== LOW-FAN-IN NON-HOT FILES (fanIn<=1, safe first batch) ===');
for (const r of report.filter(r=>!r.hot && r.fanIn<=1).sort((a,b)=>a.lines-b.lines)) console.log('lines ' + r.lines + ' fanIn ' + r.fanIn + '  ' + r.file);
