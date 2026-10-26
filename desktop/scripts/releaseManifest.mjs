/**
 * 发布产物清单（2026-10-25）：把安装包/解包目录/版本/commit 绑定成一份可校验 JSON。
 *
 * 不伪造代码签名：签名状态明确写 `signed:false`，完整性用 SHA256 + `.sha256` 清单表达。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const release = join(root, 'release');
const setup = join(release, 'OmniHarness Setup 0.2.0.exe');
const unpacked = join(release, 'win-unpacked');

/**
 * 递归统计文件数与字节数。
 * @param dir 目录。
 * @returns 统计。
 */
function walk(dir) {
  const out = { files: 0, bytes: 0 };
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const child = walk(full);
      out.files += child.files;
      out.bytes += child.bytes;
    } else {
      out.files += 1;
      out.bytes += statSync(full).size;
    }
  }
  return out;
}

/**
 * 读取 git HEAD（不 spawn git；受限环境可用）。
 * @returns commit/ref；读取失败为 null。
 */
function gitHead() {
  try {
    const dotGit = join(root, '..', '.git');
    const head = readFileSync(join(dotGit, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return { commit: head, ref: null };
    const ref = head.slice(5);
    const refFile = join(dotGit, ref);
    const commit = existsSync(refFile) ? readFileSync(refFile, 'utf8').trim() : null;
    return { commit, ref };
  } catch {
    return null;
  }
}

if (!existsSync(setup) || !existsSync(unpacked)) {
  process.stderr.write('✗ 缺少安装包或 win-unpacked；先 build/pack/installer\n');
  process.exit(2);
}
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const unpackedStats = walk(unpacked);
const hash = createHash('sha256').update(readFileSync(setup)).digest('hex');
const shaFile = `${setup}.sha256`;
const declared = existsSync(shaFile) ? readFileSync(shaFile, 'utf8').trim().split(/\s+/u)[0] : null;
const manifest = {
  product: 'OmniHarness',
  version: pkg.version,
  builtAt: new Date().toISOString(),
  git: gitHead(),
  installer: {
    file: 'OmniHarness Setup 0.2.0.exe',
    bytes: statSync(setup).size,
    sha256: hash,
    sha256ManifestMatches: declared?.toLowerCase() === hash,
    signed: false,
    signature: null,
    rollbackDir: 'OmniHarness.previous',
  },
  unpacked: {
    bytes: unpackedStats.bytes,
    files: unpackedStats.files,
    locales: ['en-US', 'zh-CN'],
  },
};
const out = join(release, 'RELEASE_MANIFEST.json');
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
process.stdout.write(
  `✅ 发布清单：${out}\n` +
    `   version=${pkg.version} installer=${(manifest.installer.bytes / 1024 / 1024).toFixed(1)} MB ` +
    `sha256=${hash.slice(0, 12)}… signed=false\n`,
);
