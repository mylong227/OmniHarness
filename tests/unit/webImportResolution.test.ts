/**
 * 前端相对导入的**可解析性**判据（2026-11-02 分层迁移的真实回归）。
 *
 * 背景：把 `src/` 拆成 contracts / kernel / protocols / apps 时，批量重写脚本把
 * `web/test/*.ts` 里的 `../src/core/Router.ts` 误改成了 `../src/kernel/core/Router.ts`
 * ——`kernel` 是**后端**的层前缀，前端目录里根本没有这个路径。类型检查抓不到
 * （`web/test` 不在根 tsconfig 的 include 里），于是 13 个前端判据在 `web:test` 里
 * 以"Failed to resolve import"整文件失败，而单看测试名全是绿的。
 *
 * 本判据把"导入路径必须真的存在"变成一条静态检查：不启动 Vitest、不需要构建，
 * 任何一次目录搬家漏改都能在 `test:fast` 里当场红。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = process.cwd();

/** 递归列出目录下的 .ts / .tsx（跳过构建产物）。 */
function sourcesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'dist' || entry.name === 'node_modules' || entry.name === 'archive') {
        continue;
      }
      out.push(...sourcesUnder(full));
      continue;
    }
    if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
      out.push(full);
    }
  }
  return out;
}

/** 抽出源文本里的静态/动态相对导入（只关心以 `.` 开头的）。 */
function relativeImports(text: string): string[] {
  const found: string[] = [];
  const re = /(?:from\s+|import\s*\(\s*)(['"])(\.[^'"]*)\1/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const spec = match[2];
    if (spec !== undefined) {
      found.push(spec);
    }
  }
  return found;
}

/**
 * 判断相对导入能否解析（文件 / 加扩展名 / 目录 index）。
 * @param importer 导入方文件绝对路径。
 * @param spec 相对说明符。
 * @returns 能解析则 true。
 */
function resolves(importer: string, spec: string): boolean {
  const base = resolve(dirname(importer), spec);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return true;
    }
  }
  return ['index.ts', 'index.tsx'].some((name) => existsSync(join(base, name)));
}

test('① web/ 下（源码与判据）的每个相对导入都必须指向真实文件', () => {
  const files = [
    ...sourcesUnder(join(ROOT, 'web', 'src')),
    ...sourcesUnder(join(ROOT, 'web', 'test')),
  ];
  const broken: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const spec of relativeImports(text)) {
      if (!resolves(file, spec)) {
        broken.push(
          `${file.replaceAll('\\', '/').replace(`${ROOT.replaceAll('\\', '/')}/`, '')} → ${spec}`,
        );
      }
    }
  }
  assert.deepStrictEqual(
    broken,
    [],
    `以下相对导入解析不到真实文件（目录搬家后漏改？）：\n${broken.join('\n')}`,
  );
});

test('② 正对照：伪造一条指向不存在目录的导入必须被判红', () => {
  const fake = join(ROOT, 'web', 'test', '__probe__.ts');
  const bad = "import { x } from '../src/kernel/core/Router.ts';\n";
  const specs = relativeImports(bad);
  assert.deepStrictEqual(specs, ['../src/kernel/core/Router.ts']);
  assert.strictEqual(resolves(fake, specs[0] ?? ''), false);
  assert.strictEqual(resolves(fake, '../src/core/Router.ts'), true);
});
