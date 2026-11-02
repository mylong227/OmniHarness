#!/usr/bin/env node
// 第二遍：范围内文本替换（src/<旧>/ → src/<新>/），跳过构建产物与依赖目录。
// 幂等：已替换过的文件再跑不会变化。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SKIP = new Set([
  'node_modules',
  'dist',
  'target',
  '.git',
  '.cache',
  '.coverage',
  '.workbuddy',
  '.changeset',
  'release',
]);
const SCOPES = [
  'src',
  'tests',
  'examples',
  'scripts',
  'docs',
  'web',
  'desktop',
  'defaults',
  'reports',
  'tools',
  '.github',
];
const ROOT_FILES = /^[^\\/]+\.(json|md|mjs|cjs|js|ts|yml|yaml|txt)$/;
const TEXT = /\.(ts|tsx|mts|cts|mjs|cjs|js|json|md|yml|yaml|html|txt|cmd|ps1)$/;

const PAIRS = [
  ['ports', 'contracts'],
  ['schema', 'contracts'],
  ['errors', 'contracts'],
  ['sdk', 'contracts'],
  ['acp', 'protocols'],
  ['mcp', 'protocols'],
  ['a2a', 'protocols'],
  ['agui', 'protocols'],
  ['cli', 'apps'],
  ['server', 'apps'],
  ['tui', 'apps'],
  ['daemon', 'apps'],
  ['license', 'apps'],
  ['enterprise', 'apps'],
  ['composition', 'apps'],
  ['hooksCompat', 'apps'],
  ['output', 'apps'],
];

const KERNEL = [
  'adapters',
  'asset',
  'autonomy',
  'capability',
  'config',
  'context',
  'core',
  'eval',
  'evolution',
  'genesis',
  'governance',
  'media',
  'native',
  'observability',
  'plugin',
  'search',
  'security',
  'skill',
  'spark',
  'subagent',
  'supervisor',
  'util',
  'worker',
];
for (const k of KERNEL) PAIRS.push([k, 'kernel']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP.has(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else out.push(path.join(dir, e.name));
  }
  return out;
}

const files = [];
for (const s of SCOPES) {
  const p = path.join(ROOT, s);
  if (fs.existsSync(p)) walk(p, files);
}
for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
  if (e.isFile() && ROOT_FILES.test(e.name)) files.push(path.join(ROOT, e.name));
}

let changed = 0;
for (const f of files) {
  if (!TEXT.test(f)) continue;
  let t;
  try {
    t = fs.readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  let next = t;
  for (const [d, layer] of PAIRS) next = next.split(`src/${d}/`).join(`src/${layer}/${d}/`);
  if (next !== t) {
    fs.writeFileSync(f, next);
    changed += 1;
  }
}
console.log(JSON.stringify({ scanned: files.length, changed }));
