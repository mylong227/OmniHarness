/**
 * 生成 NSIS 安装包（不依赖 electron-builder 的 7za spawn）。
 *
 * 优先用 `MAKENSIS_PATH`，其次 electron-builder 缓存里的 NSIS 3.04，最后 PATH 上的 makensis。
 * 普通环境：`npm run installer`；受限环境可手动 `makensis installer/OmniHarness.nsi`。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const candidates = [
  process.env['MAKENSIS_PATH'],
  join(
    process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'),
    'electron-builder',
    'Cache',
    'nsis-3.0.4.1',
    'nsis-3.0.4.1-w8az6',
    'Bin',
    'makensis.exe',
  ),
  'makensis',
].filter((item) => typeof item === 'string' && item !== '');

const makensis = candidates.find((item) => item === 'makensis' || existsSync(item));
if (makensis === undefined) {
  throw new Error('找不到 makensis：设置 MAKENSIS_PATH 或安装 NSIS 3');
}
const script = join(root, 'installer', 'OmniHarness.nsi');
const result = spawnSync(makensis, ['-INPUTCHARSET', 'UTF8', script], {
  cwd: resolve(root, 'installer'),
  stdio: 'inherit',
});
if (result.error !== undefined || result.status !== 0) {
  throw new Error(`makensis 失败：${result.error?.message ?? `exit ${String(result.status)}`}`);
}
process.stdout.write('✅ 安装包已生成：desktop/release/OmniHarness Setup 0.2.0.exe\n');
const setup = join(root, 'release', 'OmniHarness Setup 0.2.0.exe');
if (existsSync(setup)) {
  const hash = createHash('sha256').update(readFileSync(setup)).digest('hex');
  writeFileSync(`${setup}.sha256`, `${hash}  OmniHarness Setup 0.2.0.exe\n`, 'utf8');
  process.stdout.write(`   SHA256: ${hash}\n`);
}
