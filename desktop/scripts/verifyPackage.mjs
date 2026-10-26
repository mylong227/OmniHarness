#!/usr/bin/env node
/**
 * 桌面打包产物校验（2026-10-25，D2 交付门禁）。
 *
 * 不启动 Electron、不联网：只检查 `electron-builder --dir` 产物的**结构与裁剪**是否仍符合
 * 发布承诺。防止「包能打出来，但 locales/依赖/配置悄悄退化」。
 *
 * 用法：
 *   node scripts/verifyPackage.mjs [--dir release/win-unpacked]
 *
 * 判据：
 * - 入口 exe、app.asar、内置 desktop.config.json、sidecar harness 入口存在；
 * - locales 只有 en-US / zh-CN；
 * - 不含 onnxruntime-web / .old.node 等已裁掉的死重量；
 * - 输出总大小与文件数，供看板回填。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const dirFlag = args.indexOf('--dir');
const root = resolve(
  dirFlag >= 0 ? (args[dirFlag + 1] ?? 'release/win-unpacked') : 'release/win-unpacked',
);

/** 递归统计文件数与字节数。 */
function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
      continue;
    }
    out.files += 1;
    out.bytes += statSync(full).size;
    out.paths.push(full);
  }
}

const stats = { files: 0, bytes: 0, paths: [] };
if (!existsSync(root)) {
  process.stderr.write(`✗ 产物目录不存在：${root}（先 npm run pack）\n`);
  process.exit(2);
}
walk(root, stats);

const failures = [];
const requirePath = (relative, label) => {
  if (!existsSync(join(root, relative))) failures.push(`缺少 ${label}：${relative}`);
};
requirePath('OmniHarness.exe', '主程序');
requirePath(join('resources', 'app.asar'), 'app.asar');
requirePath(join('resources', 'desktop.config.json'), '内置桌面配置');
requirePath(join('resources', 'harness', 'dist', 'src', 'cli', 'exec.js'), 'sidecar 入口');

const locales = join(root, 'locales');
if (!existsSync(locales)) {
  failures.push('缺少 locales 目录');
} else {
  const allowed = new Set(['en-US.pak', 'zh-CN.pak']);
  for (const file of readdirSync(locales)) {
    if (!allowed.has(file)) failures.push(`locales 未裁剪：${file}`);
  }
}

const forbidden = ['onnxruntime-web', '.old.node', '.dsh', 'deepseek harness'];
for (const path of stats.paths) {
  const lower = path.toLowerCase();
  for (const token of forbidden) {
    if (lower.includes(token)) failures.push(`产物含禁用项 ${token}：${path}`);
  }
}

let config = {};
try {
  config = JSON.parse(readFileSync(join(root, 'resources', 'desktop.config.json'), 'utf8'));
} catch (error) {
  failures.push(`内置配置不可解析：${String(error)}`);
}
if (config.update?.channel !== 'latest') failures.push('内置配置 update.channel 应为 latest');
if (config.app?.language !== 'system') failures.push('内置配置 app.language 应为 system');

const mb = (stats.bytes / 1024 / 1024).toFixed(1);
if (failures.length > 0) {
  process.stderr.write(`✗ 打包产物校验失败（${failures.length} 项）：\n`);
  for (const item of failures) process.stderr.write(`  - ${item}\n`);
  process.exit(1);
}
const installer = join(root, '..', 'OmniHarness Setup 0.2.0.exe');
const installerNote = existsSync(installer)
  ? `${(statSync(installer).size / 1024 / 1024).toFixed(1)} MB`
  : '未生成';
process.stdout.write(
  `✅ 打包产物校验通过：${root}\n` +
    `   ${mb} MB / ${stats.files.toLocaleString('en-US')} 文件 ｜ ` +
    `locales=en-US,zh-CN ｜ channel=${String(config.update?.channel)} ｜ installer=${installerNote}\n`,
);
