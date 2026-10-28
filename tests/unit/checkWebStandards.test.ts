// 组件层（`web/src/**`）纳入体量口径的判据（2026-10-28）。
//
// ## 背景
//
// `check.mjs` 的文件行数 / 函数体行数上限此前只扫 `src/`。2026-10-17 迁移到 Vite 时的判断是
// 「React 组件天然文件长、函数长，直接套会产生 180 处误报」——那批误报是**存量**，不是不该管：
// 结果是组件层成了唯一可以无限长大的层（纳入时实测 2 个文件 >810 行、49 个函数体 >80 行，
// 最大 801 行）。
//
// ## 判据
//
// ① 真跑 `node scripts/check.mjs --strict`：必须绿，且汇总里真的有前端文件计数（口径非空转）；
// ② 两份基线都存在且**只含真正超限的条目**（文件基线每项 >810；函数基线含 web 条目）；
// ③ 接线守卫：`web/src` 的扫描循环里确实调用了文件行数 + 函数体行数两条检查
//    （否则「纳入了」只是文档里的说法）。
//
// 直跑：npm run test:fast（或 vitest run --project node tests/unit/checkWebStandards.test.ts）
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'vitest';

const ROOT = process.cwd();

/**
 * 读仓库内 JSON。
 * @param rel 仓库根相对路径
 * @returns 解析结果
 */
function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ROOT, rel), 'utf8').replace(/^\uFEFF/u, '')) as Record<
    string,
    unknown
  >;
}

test('check.mjs --strict：组件层体量口径生效且当前全绿（含前端文件计数）', () => {
  let out = '';
  let code = 0;
  try {
    out = execFileSync('node', ['scripts/check.mjs', '--strict'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    code = e.status ?? 1;
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  assert.strictEqual(code, 0, `check.mjs --strict 必须绿（输出尾部：${out.slice(-800)}）`);
  assert.match(out, /个前端文件/u, '汇总必须报出前端文件计数（口径不能空转）');
  const m = /(\d+) 个前端文件/u.exec(out);
  assert.ok(m !== null && Number(m[1]) > 100, `前端文件数异常：${m?.[1] ?? '(未匹配)'}`);
});

test('基线：文件行数基线只含真正超限的文件，函数基线含前端条目', () => {
  const fileBaseline = readJson('scripts/checkFileLengthBaseline.json');
  const fileEntries = Object.entries(fileBaseline);
  assert.ok(fileEntries.length > 0, '前端存在超限文件 ⇒ 基线不得为空（否则会被阻断）');
  for (const [file, lines] of fileEntries) {
    assert.match(file, /^web\/src\//u, `文件基线条目应来自前端：${file}`);
    assert.ok(
      typeof lines === 'number' && lines > 810,
      `${file} 的基线 ${String(lines)} 必须 >810`,
    );
  }
  const funcBaseline = readJson('scripts/checkFuncBaseline.json');
  const webFiles = Object.keys(funcBaseline).filter((f) => f.startsWith('web/src/'));
  assert.ok(webFiles.length > 0, '函数基线必须含前端条目（冻结存量，只许减不许增）');
});

test('接线：web/src 的扫描循环同时跑「文件行数」与「函数体行数」两条检查', () => {
  const script = readFileSync(join(ROOT, 'scripts', 'check.mjs'), 'utf8');
  // 定位 WEB_SRC 的循环体（到下一个空行为止的近似切片）：断言两条体量检查都在里面。
  const idx = script.indexOf('for (const f of walk(WEB_SRC))');
  assert.ok(idx >= 0, 'check.mjs 必须扫描 web/src');
  const loop = script.slice(idx, idx + 900);
  assert.match(loop, /checkFileLength\(f, src\)/u, 'web/src 必须跑文件行数检查');
  assert.match(loop, /checkLargeFunctions\(f, src\)/u, 'web/src 必须跑函数体行数检查');
  assert.doesNotMatch(loop, /checkFilename\(f\)/u, 'web 组件是 PascalCase，不得套服务端文件名规则');
});
