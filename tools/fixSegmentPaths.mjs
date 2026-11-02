#!/usr/bin/env node
// 第三遍：修「分段拼接」形式的源码路径（`join(ROOT,'src','cli','exec.js')`）。
// 纯文本替换：'src', 'X' → 'src', '<layer>', 'X'
import fs from 'node:fs';
import path from 'node:path';

const PAIRS = {
  ports: 'contracts',
  schema: 'contracts',
  errors: 'contracts',
  sdk: 'contracts',
  acp: 'protocols',
  mcp: 'protocols',
  a2a: 'protocols',
  agui: 'protocols',
  cli: 'apps',
  server: 'apps',
  tui: 'apps',
  daemon: 'apps',
  license: 'apps',
  enterprise: 'apps',
  composition: 'apps',
  hooksCompat: 'apps',
  output: 'apps',
  adapters: 'kernel',
  asset: 'kernel',
  autonomy: 'kernel',
  capability: 'kernel',
  config: 'kernel',
  context: 'kernel',
  core: 'kernel',
  eval: 'kernel',
  evolution: 'kernel',
  genesis: 'kernel',
  governance: 'kernel',
  media: 'kernel',
  native: 'kernel',
  observability: 'kernel',
  plugin: 'kernel',
  search: 'kernel',
  security: 'kernel',
  skill: 'kernel',
  spark: 'kernel',
  subagent: 'kernel',
  supervisor: 'kernel',
  util: 'kernel',
  worker: 'kernel',
};

const dirs = ['scripts', 'tests', 'examples', 'web', 'desktop', 'tools'];
const SKIP = new Set(['node_modules', 'dist', 'release', '.git', 'target', '.cache']);

function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = dirs
  .filter((d) => fs.existsSync(d))
  .flatMap((d) => walk(d))
  .filter((f) => /\.(ts|tsx|mjs|cjs|js)$/.test(f));

let changed = 0;
const hits = [];
for (const f of files) {
  const t = fs.readFileSync(f, 'utf8');
  let n = t;
  for (const [d, layer] of Object.entries(PAIRS)) {
    const from = `'src', '${d}'`;
    const to = `'src', '${layer}', '${d}'`;
    if (n.includes(from)) {
      n = n.split(from).join(to);
      hits.push(`${f}: ${d} -> ${layer}`);
    }
  }
  if (n !== t) {
    fs.writeFileSync(f, n);
    changed += 1;
  }
}
console.log(JSON.stringify({ files: files.length, changed, hits: hits.slice(0, 40) }, null, 2));
