import fs from 'node:fs';

const files = [
  'tools/probes/editMergeProbe.mjs',
  'tools/probes/evolutionLiftProbe.mjs',
  'tools/probes/memoryLiftProbe.mjs',
  'tools/probes/memorySpacingLift.mjs',
  'tools/probes/recallHitrate.mjs',
  'tools/probes/toolExposureBudget.mjs',
];

const NEEDLE = "pathToFileURL(join(ROOT, 'dist', 'src', ...segments)).href";
const REPL = "pathToFileURL(resolveDist(...segments)).href";

const HELPER = `
/**
 * 2026-11-02 分层后：dist 布局变为 dist/src/<layer>/<module>/...。
 * 探针按模块名调用（如 importDist('config', 'x.js')），这里按层前缀解析，
 * 命中不到回落旧布局（保持对旧产物的兼容）。
 */
function resolveDist(...segments) {
  const [head, ...rest] = segments;
  for (const layer of ['kernel', 'contracts', 'protocols', 'apps']) {
    const candidate = join(ROOT, 'dist', 'src', layer, head, ...rest);
    if (existsSync(candidate)) return candidate;
  }
  return join(ROOT, 'dist', 'src', ...segments);
}
`;

for (const f of files) {
  let t = fs.readFileSync(f, 'utf8');
  if (!t.includes(NEEDLE)) {
    console.log('MISS needle', f);
    continue;
  }
  t = t.split(NEEDLE).join(REPL);
  if (!/import\s*\{[^}]*existsSync[^}]*\}\s*from\s*'node:fs'/.test(t)) {
    if (/from 'node:fs';/.test(t)) {
      t = t.replace(/import \{([^}]*)\} from 'node:fs';/, (m, g) => `import {${g}, existsSync } from 'node:fs';`);
    } else {
      t = `import { existsSync } from 'node:fs';\n` + t;
    }
  }
  if (!t.includes('function resolveDist(')) t += HELPER;
  fs.writeFileSync(f, t);
  console.log('ok', f);
}
