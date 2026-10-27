/**
 * GUI 冒烟启动器（真实桌面会话专用）：带 `OMNI_SMOKE=1` 拉起 Electron，
 * 结论由主进程判定并经退出码回传（0 = 全过 / 1 = 断言失败 / 2 = 90s 超时）。
 *
 * 为什么不经 `npm start`：`npm start` 会先跑一次构建再启动，且不透传环境变量语义；
 * 本脚本假定 `npm run build` 已完成（或开发态直接可用），把额外 CLI 参数原样透传给应用
 * （如 `--workspace D:\ws`，跳过首次目录选择框）。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const electronCli = join(process.cwd(), 'node_modules', 'electron', 'cli.js');
if (!existsSync(electronCli)) {
  process.stderr.write('✗ 找不到 electron（先在 desktop/ 下 npm install）\n');
  process.exit(1);
}

const child = spawn(process.execPath, [electronCli, '.', ...process.argv.slice(2)], {
  cwd: process.cwd(),
  stdio: 'inherit',
  env: { ...process.env, OMNI_SMOKE: '1' },
});
child.on('exit', (code, signal) => {
  if (signal !== null) process.exit(1);
  process.exit(code ?? 1);
});
