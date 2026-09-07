#!/usr/bin/env node
// 零依赖覆盖率门禁：跑 `npm run coverage`（含构建 + 全量测试 + Node 内置覆盖率），
// 解析 "# all files" 行的行覆盖率，低于阈值则 exit(1)。
// 阈值来源（优先级）：命令行参数 > env MIN_LINE_COVERAGE > 默认 80。
//
// 设计取舍：不引入 lcov/tap 等第三方上报，直接解析 Node 内置文本表，保持零运行时依赖铁律。
// 测试未全绿时直接阻断（coverage 数字无意义）。
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const threshold = Number(process.env.MIN_LINE_COVERAGE ?? process.argv[2] ?? '80');

if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
  console.error(`✗ 非法覆盖率阈值: ${process.argv[2] ?? process.env.MIN_LINE_COVERAGE}`);
  process.exit(1);
}

let out = '';
let testsFailed = false;
try {
  // shell:true 关键——Windows 上 npm 是 npm.cmd（批处理），无壳直拉 .cmd 会静默失败；
  // Linux（CI）走 /bin/sh 同样正常。
  out = execFileSync('npm', ['run', 'coverage'], {
    cwd: root,
    encoding: 'utf8',
    shell: true,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
} catch (e) {
  // npm run coverage 在测试失败时会非零退出，但覆盖率表仍在 stdout，先捕获。
  testsFailed = true;
  out = (e && e.stdout) || '';
}

if (testsFailed) {
  console.error('✗ 测试运行未全绿，覆盖率门禁终止（见上方测试输出）。');
  process.exit(1);
}

const match = out.match(/# all files\s*\|\s*([\d.]+)/);
if (!match) {
  console.error('✗ 无法从覆盖率输出解析 "# all files" 行，请检查 npm run coverage 是否正常输出。');
  process.exit(1);
}

const lineCoverage = parseFloat(match[1]);
console.log(`覆盖率（行）: ${lineCoverage}%   阈值: ${threshold}%`);
if (lineCoverage < threshold) {
  console.error(`✗ 行覆盖率 ${lineCoverage}% 低于阈值 ${threshold}%，提交/CI 阻断。`);
  process.exit(1);
}
console.log('✓ 覆盖率达标');
