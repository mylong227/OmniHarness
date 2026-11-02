#!/usr/bin/env node
// 一次性切分层脚本（2026-11-02）：把 src/<模块> 归入 contracts / kernel / protocols / apps 四层，
// 并重写所有相对 import 与仓库内的 `src/<模块>/` 文本引用。
//
// 只做「纯移动 + 路径重写」，不改任何逻辑。跑完必须 `tsc --noEmit` 与全量单测兜底。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'src');

const LAYERS = {
  contracts: ['ports', 'schema', 'errors', 'sdk'],
  protocols: ['acp', 'mcp', 'a2a', 'agui'],
  apps: [
    'cli',
    'server',
    'tui',
    'daemon',
    'license',
    'enterprise',
    'composition',
    'hooksCompat',
    'output',
  ],
};

const dirs = fs
  .readdirSync(SRC, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

const layerOf = new Map();
for (const [layer, names] of Object.entries(LAYERS)) for (const n of names) layerOf.set(n, layer);
for (const d of dirs) if (!layerOf.has(d)) layerOf.set(d, 'kernel');

/** 任意旧绝对路径 → 新绝对路径（src 根文件与 src 外保持不动）。 */
function remap(abs) {
  const rel = path.relative(SRC, abs);
  if (rel.startsWith('..')) return abs;
  const seg = rel.split(path.sep);
  if (seg.length < 2) return abs;
  const layer = layerOf.get(seg[0]);
  return layer ? path.join(SRC, layer, ...seg) : abs;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', 'dist', '.git'].includes(e.name)) continue;
      walk(p, out);
    } else out.push(p);
  }
  return out;
}

const isCode = (f) => /\.(ts|tsx|mts|cts)$/.test(f);
const roots = [SRC, path.join(ROOT, 'tests'), path.join(ROOT, 'examples')].filter((d) =>
  fs.existsSync(d),
);
const files = roots.flatMap((d) => walk(d)).filter(isCode);

let rewritten = 0;
let specs = 0;

const FROM_RE = /(\bfrom\s*)(['"])([^'"]+)\2/g;
const DYN_RE = /(\bimport\s*\(\s*)(['"])([^'"]+)\2/g;
const SIDE_RE = /(\bimport\s+)(['"])([^'"]+)\2/g;

for (const f of files) {
  const oldFile = f;
  const newFile = remap(oldFile);
  const text = fs.readFileSync(oldFile, 'utf8');
  const oldDir = path.dirname(oldFile);
  const newDir = path.dirname(newFile);

  const fix = (spec) => {
    if (!spec.startsWith('.')) return null;
    const target = path.resolve(oldDir, spec);
    const newTarget = remap(target);
    let rel = path.relative(newDir, newTarget).split(path.sep).join('/');
    if (!rel.startsWith('.')) rel = './' + rel;
    if (rel === spec) return null;
    specs += 1;
    return rel;
  };

  let next = text
    .replace(FROM_RE, (m, kw, q, spec) => {
      const r = fix(spec);
      return r ? `${kw}${q}${r}${q}` : m;
    })
    .replace(DYN_RE, (m, kw, q, spec) => {
      const r = fix(spec);
      return r ? `${kw}${q}${r}${q}` : m;
    })
    .replace(SIDE_RE, (m, kw, q, spec) => {
      const r = fix(spec);
      return r ? `${kw}${q}${r}${q}` : m;
    });

  if (next !== text) {
    fs.writeFileSync(oldFile, next);
    rewritten += 1;
  }
}

// 目录整体移动
const moved = [];
for (const d of dirs) {
  const layer = layerOf.get(d);
  const from = path.join(SRC, d);
  const to = path.join(SRC, layer, d);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
  moved.push(`${d} -> ${layer}/${d}`);
}

// 文本引用重写：src/<旧>/ → src/<新>/（同时覆盖 dist/src/<旧>/ 里的同一子串）
const TEXT_EXT = /\.(ts|tsx|mts|cts|mjs|cjs|js|json|md|yml|yaml|html|txt)$/;
const textFiles = walk(ROOT).filter(
  (f) => TEXT_EXT.test(f) && !f.includes(`${path.sep}node_modules${path.sep}`),
);
const pairs = dirs
  .map((d) => [d, layerOf.get(d)])
  .filter(([d, layer]) => `${layer}/${d}` !== d);

let textChanged = 0;
for (const f of textFiles) {
  let t;
  try {
    t = fs.readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  let next = t;
  for (const [d, layer] of pairs) {
    next = next.split(`src/${d}/`).join(`src/${layer}/${d}/`);
  }
  if (next !== t) {
    fs.writeFileSync(f, next);
    textChanged += 1;
  }
}

console.log(
  JSON.stringify({ modules: dirs.length, moved: moved.length, rewritten, specs, textChanged }, null, 2),
);
