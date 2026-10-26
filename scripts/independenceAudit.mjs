#!/usr/bin/env node
/**
 * 独立性门禁（2026-10-25）：产品代码不得再带任何外部 harness 的“影子”。
 *
 * 扫描面是**运行时代码 + 配置 + 脚本 + 测试**（不含 docs/reports 历史分析），禁止：
 *  - `dsh` / `DSH` 标识；
 *  - `DeepSeek Harness`；
 *  - `@deepseek/*` 依赖；
 *  - `.dsh/` 路径；
 *  - `DSH_*` 环境变量。
 *
 * 为什么需要它：口头“去除影子”会漂移；门禁把“本项目可独立构建/运行/测试”变成可执行判据。
 * 允许的第三方服务（GitHub、模型厂商 API、npm 仓库）不在此列——它们是**可选外联**，
 * 不是运行时宿主。
 *
 * 用法：`npm run audit:independence`；退出码 0 = 干净，1 = 发现引用。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

const ROOT = process.cwd();
const SCAN_DIRS = [
  'src',
  'desktop/src',
  'web/src',
  'scripts',
  'defaults',
  'tests',
  'docs',
  'reports',
  '.github',
];
const SCAN_FILES = [
  'package.json',
  'tsconfig.json',
  'vite.config.ts',
  'vitest.config.ts',
  'vitest.workspace.ts',
  'eslint.config.mjs',
  'eslint.typed.config.mjs',
];
const EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mjs',
  '.js',
  '.json',
  '.yml',
  '.yaml',
  '.css',
  '.html',
  '.rs',
  '.toml',
]);
const FORBIDDEN = [
  { pattern: /\bdsh\b/iu, label: 'dsh 标识' },
  { pattern: /DeepSeek\s+Harness/iu, label: 'DeepSeek Harness 名称' },
  { pattern: /@deepseek\//iu, label: '@deepseek/* 依赖' },
  { pattern: /\.dsh[\\/]/iu, label: '.dsh/ 路径' },
  { pattern: /\bDSH_[A-Z]/u, label: 'DSH_* 环境变量' },
];

/** 递归收集待扫描文件。 */
function collect(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'target') continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      collect(abs, out);
      continue;
    }
    if (EXTENSIONS.has(extname(entry.name))) out.push(abs);
  }
}

const files = [];
for (const dir of SCAN_DIRS) collect(join(ROOT, dir), files);
for (const file of SCAN_FILES) {
  try {
    readFileSync(join(ROOT, file));
    files.push(join(ROOT, file));
  } catch {
    // 可选文件缺失不算违规。
  }
}

const findings = [];
for (const file of files) {
  // 门禁脚本自身必须写出被禁模式才能扫描；跳过自己，避免自指。
  if (file.endsWith('independenceAudit.mjs')) continue;
  const text = readFileSync(file, 'utf8');
  for (const rule of FORBIDDEN) {
    if (!rule.pattern.test(text)) continue;
    const line = text.split(/\r?\n/u).findIndex((row) => rule.pattern.test(row)) + 1;
    findings.push({ file: relative(ROOT, file), line, label: rule.label });
  }
}

if (findings.length === 0) {
  process.stdout.write(
    `✅ 独立性门禁通过：扫描 ${String(files.length)} 个文件，零外部 harness 引用\n`,
  );
  process.exit(0);
}
process.stderr.write(`✗ 发现 ${String(findings.length)} 处外部 harness 引用：\n`);
for (const item of findings) {
  process.stderr.write(`  ${item.file}:${String(item.line)}  ${item.label}\n`);
}
process.exit(1);
