// Codemod: insert explicit `public` accessibility modifier on class members that
// currently rely on the implicit public default (standard #1, docs/CODE_STANDARD.md).
//
// Why safe: TypeScript treats a member with NO accessibility modifier as `public`,
// so inserting an explicit `public` is a no-op semantically — it only makes the
// existing (public) reality explicit. We deliberately do NOT guess `private`:
// tightening encapsulation is a judgement call handled in later review batches.
//
// Usage:
//   node scripts/codemod/memberAccessibility.mjs --dry        # report only
//   node scripts/codemod/memberAccessibility.mjs             # apply to non-hot files
//   node scripts/codemod/memberAccessibility.mjs <file...>    # apply to specific files
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const HOT_PREFIXES = ['src/adapters/live/'];
const HOT_FILES = new Set([
  'src/core/stepRunner.ts',
  'src/core/turnRunner.ts',
  'src/ports/toolInputSink.ts',
]);

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const explicit = args.filter((a) => !a.startsWith('--'));

function isHot(f) {
  const k = f.split(path.sep).join('/');
  return HOT_FILES.has(k) || HOT_PREFIXES.some((p) => k.startsWith(p));
}

const ROOTS = ['src', 'tests', 'web/src'];
const SKIP_DIRS = ['node_modules', 'dist', 'vendor', '.omni-worktrees'];

function collectFiles() {
  if (explicit.length) return explicit;
  const out = [];
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.includes(e.name)) continue;
        walk(p);
      } else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(p);
    }
  };
  for (const r of ROOTS) walk(r);
  return out.filter((f) => !isHot(f));
}

/** True if a member already declares an accessibility keyword. */
function hasAccessibility(member) {
  const mods = member.modifiers || [];
  return mods.some((m) =>
    [ts.SyntaxKind.PublicKeyword, ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword].includes(m.kind),
  );
}

/** Members the rule requires accessibility on, and that lack it. */
function needsPublic(member) {
  const kinds = [
    ts.isMethodDeclaration,
    ts.isPropertyDeclaration,
    ts.isConstructorDeclaration,
    ts.isGetAccessorDeclaration,
    ts.isSetAccessorDeclaration,
  ];
  if (!kinds.some((k) => k(member))) return false;
  if (hasAccessibility(member)) return false;
  // ECMAScript #private members cannot carry an accessibility modifier.
  if (member.name && ts.isPrivateIdentifier(member.name)) return false;
  // Only real class members (object-literal methods share the same node kind).
  const parent = member.parent;
  if (!ts.isClassDeclaration(parent) && !ts.isClassExpression(parent)) return false;
  return true;
}

/** Insert `public ` at the correct spot (after decorators / before other modifiers). */
function insertionPos(member) {
  const mods = member.modifiers || [];
  const decorators = mods.filter((m) => ts.isDecorator(m));
  const firstNonDecorator = mods.find((m) => !ts.isDecorator(m));
  if (decorators.length) {
    if (firstNonDecorator) return firstNonDecorator.getStart();
    if (member.name && member.name.getStart) return member.name.getStart();
  }
  return member.getStart();
}

const files = collectFiles();
let totalMembers = 0;
const touched = [];
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  const sf = ts.createSourceFile(f, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const positions = [];
  const visit = (node) => {
    if ((ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.members) {
      for (const m of node.members) {
        if (needsPublic(m)) positions.push(insertionPos(m));
        // Constructor parameter properties: a parameter carrying `readonly` (or another
        // modifier) but no accessibility keyword is a parameter property and must be explicit.
        if (ts.isConstructorDeclaration(m)) {
          for (const p of m.parameters) {
            const mods = p.modifiers || [];
            if (mods.length === 0) continue; // plain parameter, not a property
            const hasAccess = mods.some((x) =>
              [ts.SyntaxKind.PublicKeyword, ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword].includes(x.kind),
            );
            if (!hasAccess) positions.push(p.getStart());
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!positions.length) continue;
  totalMembers += positions.length;
  touched.push([f, positions.length]);
  if (dry) continue;
  // Apply descending so earlier offsets stay valid.
  const uniq = [...new Set(positions)].sort((a, b) => b - a);
  let out = text;
  for (const pos of uniq) out = out.slice(0, pos) + 'public ' + out.slice(pos);
  fs.writeFileSync(f, out);
}

console.log((dry ? '[DRY] ' : '') + 'files touched: ' + touched.length + '   members fixed: ' + totalMembers);
for (const [f, c] of touched.sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(c + '  ' + f.replace('src/', ''));
