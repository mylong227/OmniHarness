import fs from 'node:fs';
import path from 'node:path';

const SRC = 'src';
const KEEP = new Set(['apps', 'contracts', 'kernel', 'protocols']);
const LAYERS = ['apps', 'contracts', 'kernel', 'protocols'];

// 安全检查：每个被删的旧目录，其内容必须已存在于对应层下。
const moved = new Map();
for (const layer of LAYERS) {
  for (const d of fs.readdirSync(path.join(SRC, layer), { withFileTypes: true })) {
    if (d.isDirectory()) moved.set(d.name, layer);
  }
}

const removed = [];
const missing = [];
for (const e of fs.readdirSync(SRC, { withFileTypes: true })) {
  if (!e.isDirectory() || KEEP.has(e.name)) continue;
  if (!moved.has(e.name)) {
    missing.push(e.name);
    continue;
  }
  fs.rmSync(path.join(SRC, e.name), { recursive: true, force: true });
  removed.push(e.name);
}
console.log(JSON.stringify({ removed: removed.length, missing }, null, 2));
