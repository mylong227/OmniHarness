#!/usr/bin/env node
// 零依赖：把 git core.hooksPath 指向仓库内 scripts/git-hooks，
// 使 pre-commit 门禁（铁律自检 + ESLint + Prettier）在每次提交时自动生效。
// 用法：node scripts/install-hooks.mjs
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const hookDir = join(root, 'scripts', 'git-hooks');

try {
  execSync(`git config core.hooksPath "${hookDir}"`, { cwd: root, stdio: 'inherit' });
  console.log(`✓ core.hooksPath 已设为 ${hookDir}`);
  console.log('  后续提交将自动触发：铁律自检 + ESLint + Prettier 增量格式化');
} catch (e) {
  console.error('✗ 设置 core.hooksPath 失败：', e.message);
  process.exit(1);
}
