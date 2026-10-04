/**
 * G2 CLI 判据（`bundle source list|sync`）：私有技能源必须被**真实路径**消费。
 *
 * ## 判据要钉死什么
 *
 * 1. **`list` 只读**：严格档 + 无签名 ⇒ `✗` 且退出码 1（CI 可察觉），**不装任何东西**；
 * 2. **`sync` 严格档**：无签名包被拒、签名包被装（**真**走既有 `unpackBundle` ⇒ 插件目录里出现文件）；
 * 3. **`--loose` 不当严格档**：同一个无签名包在宽松档被收下，但输出里明确标 `community`（不静默提档）；
 * 4. **用法错误 ⇒ 2**；缺 `--source` ⇒ 2。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BundleCommand } from '../../src/cli/bundleCommand.js';
import { PluginBundler } from '../../src/plugin/pluginBundler.js';
import { Ed25519AgentIdentity } from '../../src/adapters/identity/ed25519AgentIdentity.js';

/** 发布者身份（真密钥）。 */
const PUBLISHER = new Ed25519AgentIdentity({ agentRuntimeId: 'publisher' });

/**
 * 采集 stdout/stderr 并跑命令。
 * @param run 被测动作
 * @returns 两条流文本与退出码
 */
async function capture(run: () => Promise<number>): Promise<{
  readonly out: string;
  readonly err: string;
  readonly code: number;
}> {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: unknown }).write = (chunk: unknown): boolean => {
    outChunks.push(String(chunk));
    return true;
  };
  (process.stderr as unknown as { write: unknown }).write = (chunk: unknown): boolean => {
    errChunks.push(String(chunk));
    return true;
  };
  try {
    // 注意顺序：必须先 await 跑完命令，再取两条流——写成 `{ out: chunks.join(''), code: await run() }`
    // 会**先**求值 out（此时命令还没跑）⇒ 永远拿到空串（本判据第一版就是这么错的）。
    const code = await run();
    return { out: outChunks.join(''), err: errChunks.join(''), code };
  } finally {
    (process.stdout as unknown as { write: unknown }).write = originalOut;
    (process.stderr as unknown as { write: unknown }).write = originalErr;
  }
}

/**
 * 造一个带插件的 `.ohb`（可选签名）并放进源目录。
 * @param root 根目录
 * @param name 包名
 * @param signed 是否 Ed25519 签名
 * @returns 源目录路径
 */
async function makeSource(root: string, name: string, signed: boolean): Promise<string> {
  const sourceDir = join(root, 'source');
  mkdirSync(sourceDir, { recursive: true });
  const workspace = join(root, `ws-${name}`);
  // 造一个真实插件目录，让 unpack 有东西可还原（否则"装成功"无法与"没装"区分）。
  const pluginDir = join(workspace, 'plugins-src', 'demo-plugin');
  mkdirSync(pluginDir, { recursive: true });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(pluginDir, 'index.js'), 'export const name = "demo";\n', 'utf8');
  const bundler = new PluginBundler();
  const result = await bundler.packBundle({
    workspaceDir: workspace,
    profile: { name, plugins: ['demo-plugin'], config: { k: name } },
    registry: {
      get: () =>
        Promise.resolve({
          name: 'demo-plugin',
          source: 'path',
          installFrom: { kind: 'path', path: pluginDir },
        }),
      list: () => Promise.resolve([]),
    } as never,
    pluginsDir: join(root, 'plugins'),
    outDir: sourceDir,
    ...(signed ? { identity: PUBLISHER } : {}),
  });
  return result.path;
}

test('G2 CLI：严格档 list 对无签名包报 ✗ 且退出码 1，且**不安装**任何东西', async () => {
  const root = mkdtempSync(join(tmpdir(), 'g2cli-'));
  await makeSource(root, 'plain', false);
  const pluginsDir = join(root, 'installed');
  const { out, code } = await capture(() =>
    new BundleCommand(() => ({}) as never).runBundle([
      'source',
      'list',
      '--source',
      join(root, 'source'),
      '--trust',
      PUBLISHER.publicKeySsh(),
      '--dir',
      pluginsDir,
    ]),
  );
  assert.strictEqual(code, 1, `存在被拒包必须非零退出：${out}`);
  assert.match(out, /✗ plain@0\.1\.0（community，签名=none）/);
  assert.match(out, /严格档要求 Ed25519 签名/);
  assert.ok(!existsSync(pluginsDir), 'list 是只读命令：不得创建/写入安装目录');
});

test('G2 CLI：严格档 sync 只装签名包（真走 unpack），被拒包给出可读原因', async () => {
  const root = mkdtempSync(join(tmpdir(), 'g2sync-'));
  await makeSource(root, 'a-signed', true);
  await makeSource(root, 'b-plain', false);
  const pluginsDir = join(root, 'installed');
  const { out, err, code } = await capture(() =>
    new BundleCommand(() => ({}) as never).runBundle([
      'source',
      'sync',
      '--source',
      join(root, 'source'),
      '--trust',
      PUBLISHER.publicKeySsh(),
      '--dir',
      pluginsDir,
    ]),
  );
  assert.strictEqual(code, 1, '存在被拒包 ⇒ 非零退出');
  assert.match(out, /已安装 1 个：a-signed/);
  assert.match(err, /被拒 1 个：b-plain/);
  assert.match(err, /b-plain：严格档要求 Ed25519 签名/);
  // 真装了：安装目录里出现插件（证明 sync 走的是既有 unpack 路径，不是空转）。
  assert.ok(existsSync(join(pluginsDir, 'demo-plugin')), '签名包必须真的被还原到插件目录');
  assert.deepStrictEqual(readdirSync(pluginsDir), ['demo-plugin']);
});

test('G2 CLI：--loose 收下无签名包但输出标注 community（不静默提档）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'g2loose-'));
  await makeSource(root, 'plain', false);
  const pluginsDir = join(root, 'installed');
  const { out, code } = await capture(() =>
    new BundleCommand(() => ({}) as never).runBundle([
      'source',
      'list',
      '--source',
      join(root, 'source'),
      '--trust',
      PUBLISHER.publicKeySsh(),
      '--loose',
      '--dir',
      pluginsDir,
    ]),
  );
  assert.strictEqual(code, 0, '宽松档应全放行');
  assert.match(out, /✓ plain@0\.1\.0（community，签名=none）/);
  assert.match(out, /档位：宽松/);
});

test('G2 CLI：用法错误与缺 --source ⇒ 退出码 2', async () => {
  const command = new BundleCommand(() => ({}) as never);
  const badAction = await capture(() => command.runBundle(['source', 'purge']));
  assert.strictEqual(badAction.code, 2);
  assert.match(badAction.out, /bundle source list\|sync/);

  const noSource = await capture(() => command.runBundle(['source', 'list']));
  assert.strictEqual(noSource.code, 2, '缺 --source 必须报用法错误，而不是"源为空 ⇒ 全过"');

  const noSub = await capture(() => command.runBundle([]));
  assert.strictEqual(noSub.code, 2);
});
