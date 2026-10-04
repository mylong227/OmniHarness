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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
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

test('H1 CLI：grade 对干净包评 A（退出码 0），对未声明能力的包评 C（退出码 1）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'h1cli-'));
  // 干净包：入口是纯计算，静态无证据、沙箱跑得通、无声明能力 ⇒ A。
  // 入口用 **cjs 风格**：沙箱 `vm` 档按脚本语义执行、不认 ESM 的 `export`（已知边界，见下一条判据）。
  const clean = await packWith(
    root,
    'clean',
    'function run(s) { return s.split("").reverse().join(""); }\nmodule.exports = { run };\n',
  );
  const a = await capture(() =>
    new BundleCommand(() => ({}) as never).runBundle(['grade', clean, '--declare', '']),
  );
  assert.strictEqual(a.code, 0, a.out + a.err);
  assert.match(a.out, /评级 A（可安装）/);
  assert.match(a.out, /证据：扫过 \d+ 文件/);

  // 危险包：起进程但**不声明** process ⇒ 差异测试一票 C。
  const risky = await packWith(
    root,
    'risky',
    'const { execSync } = require("node:child_process");\nmodule.exports = { run: () => execSync("ls") };\n',
  );
  const c = await capture(() => new BundleCommand(() => ({}) as never).runBundle(['grade', risky]));
  assert.strictEqual(c.code, 1, 'C 必须非零退出（市场/安装器据此拒绝）');
  assert.match(c.out, /评级 C（不可安装）/);
  assert.match(c.out, /存在未声明能力：process/);
  assert.match(c.out, /未声明 \[process\]/);

  // 同一包声明了 process ⇒ 降为 B（可安装，标注需授权）。
  const b = await capture(() =>
    new BundleCommand(() => ({}) as never).runBundle(['grade', risky, '--declare', 'process']),
  );
  assert.strictEqual(b.code, 0, b.out + b.err);
  assert.match(b.out, /评级 B（可安装）/);
  assert.match(b.out, /已声明的高危能力：process/);

  // 缺参数 ⇒ 用法错误。
  const usage = await capture(() => new BundleCommand(() => ({}) as never).runBundle(['grade']));
  assert.strictEqual(usage.code, 2);
  assert.match(usage.out, /bundle grade/);
});

/**
 * 打一个只含 `index.js` 的最小包（H1 分级夹具）。
 * @param root 根目录
 * @param name 包名
 * @param code 入口代码
 * @returns 包路径
 */
async function packWith(root: string, name: string, code: string): Promise<string> {
  const sourceDir = join(root, `grade-src-${name}`);
  mkdirSync(sourceDir, { recursive: true });
  const workspace = join(root, `ws-grade-${name}`);
  const pluginDir = join(workspace, 'plugins-src', name);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, 'index.js'), code, 'utf8');
  const result = await new PluginBundler().packBundle({
    workspaceDir: workspace,
    profile: { name, plugins: [name], config: {} },
    registry: {
      get: () =>
        Promise.resolve({ name, source: 'path', installFrom: { kind: 'path', path: pluginDir } }),
      list: () => Promise.resolve([]),
    } as never,
    pluginsDir: join(root, 'plugins'),
    outDir: sourceDir,
  });
  return result.path;
}
