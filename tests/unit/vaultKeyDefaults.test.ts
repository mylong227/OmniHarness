/**
 * 凭据保险库**默认主密钥**判据（2026-10-11）。
 *
 * ## 背景（实测 footgun）
 *
 * `CryptoVault` 无主密钥来源时用**内存随机密钥**且不落盘 ⇒ `vault set` 当次看着成功，
 * 进程一退密文**永久读不回**。这正是 serve 侧此前拒绝注入保险库、启动横幅常驻
 * `ℹ️ 凭据保险库未接线` 的根因。本轮改为：无显式来源时用用户级默认密钥文件
 * `~/.omniharness/vault.key`（首次使用时生成，0600）。
 *
 * ## 判据口径
 *
 * | # | 判据 | 坏掉的后果 |
 * | --- | --- | --- |
 * | ① | 默认路径 = `~/.omniharness/vault.key`；显式 `--vault-key-file` 优先；来源描述不带密钥内容 | 默认没生效 ⇒ 回到 footgun |
 * | ② | **跨进程持久化**（真起 CLI 子进程，临时 HOME）：`vault set` 之后**另一个进程** `vault get` 必须取回原值 | 内存随机密钥 ⇒ 密文读不回（本判据修前必红） |
 * | ③ | 正对照：换一个 HOME（换密钥文件）后同一条目**读不到**（fail-closed 报错，不是返回错误明文） | ② 可能恒真 |
 * | ④ | 环境变量优先：换 `OMNIHARNESS_VAULT_KEY` 后读旧密文必须**报错**，同密钥必须能读回 | 静默返回错误明文 = 更危险；或"永远失败"被当成正确 |
 * | ⑤ | `OMNIHARNESS_VAULT=0` ⇒ serve 不注入保险库，且**不创建**密钥文件（真起 serve 后查盘 + 接线断言） | 用户明确关掉了却被偷偷建密钥 |
 * | ⑥ | **`--vault-hydrate` 默认必须真能水合**（真起 CLI 子进程）：别的进程 `vault set` 进去的凭据，带该旗标必须取回 | 半接线：serve 侧已默认接线，水合侧还按旧口径跳过（本判据修前必红） |
 * | ⑦ | `OMNIHARNESS_VAULT=0` ⇒ `--vault-hydrate` 跳过并**如实说明**跳过原因（不得谎称水合成功） | 关掉了却悄悄继续读保险库 |
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_VAULT_KEY_FILE, VaultKeyDefaults } from '../../src/cli/vaultKeyDefaults.ts';

/** 仓库根。 */
const REPO_ROOT = process.cwd();
/** CLI 入口。 */
const CLI = join(REPO_ROOT, 'dist/src/cli/exec.js');

/**
 * 在给定 HOME 下跑一次 CLI（真子进程）。
 * @param args 子命令参数
 * @param home 临时 HOME（同时设 HOME 与 USERPROFILE，两个平台都能生效）
 * @param env 额外环境
 * @returns 退出码与输出
 */
function runCli(
  args: readonly string[],
  home: string,
  env: NodeJS.ProcessEnv = {},
): { code: number; out: string } {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, OMNI_REPO_MAP: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // 合并 stdout+stderr：水合提示与"跳过说明"都写在 **stderr** 上，只收 stdout 会把它们
  // 整条吞掉 ⇒ 判据只看 stdout 时既可能假绿也可能假红（本轮首跑就栽在这里）。
  return { code: res.status ?? 1, out: `${res.stdout ?? ''}\n${res.stderr ?? ''}` };
}

test('① 默认主密钥文件 = ~/.omniharness/vault.key；显式路径优先；来源描述不带密钥', () => {
  assert.match(DEFAULT_VAULT_KEY_FILE, /\.omniharness[/\\]vault\.key$/u, '默认路径口径');
  assert.strictEqual(
    VaultKeyDefaults.resolveKeyFile(undefined),
    DEFAULT_VAULT_KEY_FILE,
    '未显式给出时用默认路径',
  );
  assert.strictEqual(
    VaultKeyDefaults.resolveKeyFile('  '),
    DEFAULT_VAULT_KEY_FILE,
    '空白视为未给出',
  );
  assert.strictEqual(VaultKeyDefaults.resolveKeyFile('D:/x/k.key'), 'D:/x/k.key', '显式路径优先');

  assert.match(VaultKeyDefaults.describeSource(undefined, {}), /密钥文件/u);
  const fromEnv = VaultKeyDefaults.describeSource(undefined, {
    OMNIHARNESS_VAULT_KEY: 'secret-value',
  });
  assert.match(fromEnv, /环境变量/u);
  assert.doesNotMatch(fromEnv, /secret-value/u, '来源描述绝不能带出密钥内容');
});

test('② 跨进程持久化：进程 A `vault set` → 进程 B `vault get` 必须取回（修前必红）', () => {
  const home = mkdtempSync(join(tmpdir(), 'omni-vault-home-'));
  const kvFile = join(home, 'kv.json');
  try {
    const set = runCli(
      ['vault', 'set', '--name', 'demo', '--value', 'v-123', '--kv-file', kvFile],
      home,
    );
    assert.strictEqual(set.code, 0, `set 应成功：\n${set.out}`);
    const keyFile = join(home, '.omniharness', 'vault.key');
    assert.ok(existsSync(keyFile), `默认密钥文件未生成：${keyFile}\n${set.out}`);
    assert.ok(readFileSync(keyFile, 'utf8').trim().length > 0, '密钥文件不得为空');

    const got = runCli(['vault', 'get', '--name', 'demo', '--kv-file', kvFile], home);
    assert.strictEqual(got.code, 0, `另一进程应能取回：\n${got.out}`);
    assert.match(got.out, /v-123/u, '必须取回原值');
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('③ 正对照：换一个 HOME（换密钥文件）后同一条目读不回，且**不得**返回错误明文', () => {
  const homeA = mkdtempSync(join(tmpdir(), 'omni-vault-a-'));
  const homeB = mkdtempSync(join(tmpdir(), 'omni-vault-b-'));
  const kvFile = join(homeA, 'kv.json');
  try {
    assert.strictEqual(
      runCli(['vault', 'set', '--name', 'k', '--value', 'value-A', '--kv-file', kvFile], homeA)
        .code,
      0,
      '先写入',
    );
    const other = runCli(['vault', 'get', '--name', 'k', '--kv-file', kvFile], homeB);
    assert.notStrictEqual(other.code, 0, '换了密钥文件后必须失败，而不是返回明文');
    assert.doesNotMatch(other.out, /value-A/u, '失败路径绝不能吐出明文');
  } finally {
    rmSync(homeA, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    rmSync(homeB, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('④ 环境变量优先：换 OMNIHARNESS_VAULT_KEY 后读旧密文必须报错，同密钥必须能读回', () => {
  const home = mkdtempSync(join(tmpdir(), 'omni-vault-c-'));
  const kvFile = join(home, 'kv.json');
  try {
    assert.strictEqual(
      runCli(['vault', 'set', '--name', 'k', '--value', 'envval', '--kv-file', kvFile], home, {
        OMNIHARNESS_VAULT_KEY: 'key-one',
      }).code,
      0,
      '用第一个环境变量密钥写入',
    );
    const wrong = runCli(['vault', 'get', '--name', 'k', '--kv-file', kvFile], home, {
      OMNIHARNESS_VAULT_KEY: 'key-two',
    });
    assert.notStrictEqual(wrong.code, 0, '换密钥后必须失败');
    assert.doesNotMatch(wrong.out, /envval/u, '失败路径绝不能吐出明文');

    const right = runCli(['vault', 'get', '--name', 'k', '--kv-file', kvFile], home, {
      OMNIHARNESS_VAULT_KEY: 'key-one',
    });
    assert.strictEqual(right.code, 0, `同密钥应能读回：\n${right.out}`);
    assert.match(right.out, /envval/u);
    assert.strictEqual(
      VaultKeyDefaults.describeSource(undefined, { OMNIHARNESS_VAULT_KEY: 'key-one' }),
      '环境变量 OMNIHARNESS_VAULT_KEY',
      '环境变量优先于密钥文件',
    );
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('⑥ --vault-hydrate 默认必须可用（真起 CLI 子进程；**修前必红**）', () => {
  const home = mkdtempSync(join(tmpdir(), 'omni-vault-hydrate-'));
  const kvFile = join(home, 'kv.json');
  try {
    // 进程 A：按默认口径（用户级默认密钥文件）写入一条凭据。
    const set = runCli(
      [
        'vault',
        'set',
        '--name',
        'OMNI_PROBE_KEY',
        '--value',
        'probe-secret-42',
        '--kv-file',
        kvFile,
      ],
      home,
    );
    assert.strictEqual(set.code, 0, `vault set 应成功：\n${set.out}`);

    // 进程 B：只给 --vault-hydrate（**不给**任何主密钥来源）⇒ 必须真的水合出来。
    // 修之前这里回的是「⚠️ --vault-hydrate 缺少主密钥来源…已跳过水合」：
    // serve 侧已经按默认密钥文件接线了，水合侧却还卡在旧口径 ⇒ 同一进程两种口径。
    const run = runCli(
      [
        '--mock',
        '--vault-hydrate',
        '--vault-hydrate-names',
        'OMNI_PROBE_KEY',
        '--kv-file',
        kvFile,
        'probe',
      ],
      home,
    );
    assert.doesNotMatch(run.out, /缺少主密钥来源/u, '不得再以"缺少主密钥来源"跳过水合');
    assert.match(
      run.out,
      /已从凭据保险库水合 1 项: OMNI_PROBE_KEY/u,
      `默认口径下必须真水合出来：\n${run.out}`,
    );
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('⑦ OMNIHARNESS_VAULT=0 ⇒ --vault-hydrate 跳过并如实说明（不得谎称成功）', () => {
  const home = mkdtempSync(join(tmpdir(), 'omni-vault-hydrate-off-'));
  const kvFile = join(home, 'kv.json');
  try {
    assert.strictEqual(
      runCli(
        [
          'vault',
          'set',
          '--name',
          'OMNI_PROBE_KEY',
          '--value',
          'probe-secret-42',
          '--kv-file',
          kvFile,
        ],
        home,
      ).code,
      0,
      '先写入一条凭据（后面验证它不会被水合）',
    );
    const run = runCli(
      [
        '--mock',
        '--vault-hydrate',
        '--vault-hydrate-names',
        'OMNI_PROBE_KEY',
        '--kv-file',
        kvFile,
        'probe',
      ],
      home,
      { OMNIHARNESS_VAULT: '0' },
    );
    assert.match(run.out, /OMNIHARNESS_VAULT=0 跳过/u, '必须说明是因开关而跳过');
    assert.doesNotMatch(
      run.out,
      /已从凭据保险库水合 \d+ 项/u,
      '关掉了还报告"已水合" ⇒ 判据⑥可能恒真',
    );
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('⑤ OMNIHARNESS_VAULT=0 ⇒ 关闭；serve 不创建密钥文件（真起后查盘 + 接线断言）', () => {
  for (const off of ['0', 'off', 'false', ' OFF ']) {
    assert.strictEqual(
      VaultKeyDefaults.disabledByEnv({ OMNIHARNESS_VAULT: off }),
      true,
      `${off} 应关闭`,
    );
  }
  for (const on of ['', '1', 'yes']) {
    assert.strictEqual(
      VaultKeyDefaults.disabledByEnv({ OMNIHARNESS_VAULT: on }),
      false,
      `${on} 不应关闭`,
    );
  }
  assert.strictEqual(VaultKeyDefaults.disabledByEnv({}), false, '未设 ⇒ 默认开启');

  // 真起一次 serve（6 秒后杀掉：它常驻，不能用 execFileSync 等它退出——首版就是这么写死自己的）。
  const home = mkdtempSync(join(tmpdir(), 'omni-vault-off-'));
  try {
    const proc = spawn(process.execPath, [CLI, 'serve', '--workspace', home, '--port', '0'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        OMNIHARNESS_VAULT: '0',
        OMNI_SEMANTIC_RECALL: '0',
        OMNI_REPO_MAP: '0',
      },
      stdio: 'ignore',
    });
    const started = Date.now();
    while (Date.now() - started < 6000) {
      // 等它把启动路径走完（含 buildServeVault）——被关闭时它不会碰密钥文件。
      execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},200)'], { stdio: 'ignore' });
      if (existsSync(join(home, '.omniharness'))) {
        break;
      }
    }
    try {
      proc.kill('SIGTERM');
    } catch {
      /* 已退出 */
    }
    assert.strictEqual(
      existsSync(join(home, '.omniharness', 'vault.key')),
      false,
      'OMNIHARNESS_VAULT=0 时不得创建密钥文件',
    );
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }

  // 接线断言（附正对照）：serve 侧必须先查开关再构造 vault。
  const source = readFileSync(join(REPO_ROOT, 'src/cli/cliCredentialBuild.ts'), 'utf8');
  assert.match(
    source,
    /disabledByEnv\(\)[\s\S]{0,200}?return undefined;/u,
    'buildServeVault 必须：关掉了就返回 undefined（不构造、不碰密钥文件）',
  );
  assert.match(
    source,
    /VaultKeyDefaults\.resolveKeyFile\(args\.vaultKeyFile\)/u,
    '未关闭时必须走默认密钥文件解析',
  );
  const mutated = source.replace('VaultKeyDefaults.disabledByEnv()', 'alwaysEnabled()');
  assert.notStrictEqual(mutated, source, '正对照变异未落地');
  assert.doesNotMatch(
    mutated,
    /disabledByEnv\(\)[\s\S]{0,200}?return undefined;/u,
    '去掉开关判断却检不出来 ⇒ 本判据恒真',
  );
});
