/**
 * `node:sqlite` **懒加载**的判据（2026-10-08 易用性轮）。
 *
 * ## 被改的形态（客户眼里的"一启动就报错"）
 *
 * `sqliteKv.ts` 顶层曾是 `import { DatabaseSync } from 'node:sqlite'`。`src/adapters/index.ts`
 * 这条 barrel 把它**静态**带进 CLI 装配链（`cliServerCmds` → `adapters/index` → `sqliteKv`），
 * 于是**每一条**命令——包括 `doctor` / `session list` / `kv list --kv-adapter memory`——
 * 都会先在 stderr 打一行：
 *
 * ```
 * (node:12345) ExperimentalWarning: SQLite is an experimental feature and might change at any time
 * ```
 *
 * 它既不是错误，也不该在**没用到 sqlite** 时出现；而同类文件 `sqliteStorage.ts` 早已是懒加载写法，
 * `kvStoreFactory.ts` 的注释也写着"sqlite 后端**懒加载**"——**声明与实现不一致**（本次修的是这条）。
 *
 * ## 判据
 *
 * | # | 判据 | 为什么不能只写"改完看起来对了" |
 * |---|------|--------------------------------|
 * | ① | 结构：`src/**` 里**不得**有 `node:sqlite` 的值导入（`import type` 允许） | 防回归；这是唯一不依赖构建产物的机械判据 |
 * | ② | 实跑负对照：不碰 sqlite 的命令，stderr **不得**含该警告 | 端到端证明噪声真的没了（结构对≠行为对） |
 * | ③ | 实跑正对照：真选 `--kv-adapter sqlite` 时仍能读写 | 证明懒加载没把功能改坏（判据不是"删掉功能"） |
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const CLI_ENTRY = join(ROOT, 'dist', 'src', 'cli', 'exec.js');

/** 该警告的稳定子串（Node 各小版本前缀 `(node:pid)` 会变，故只匹配文案）。 */
const WARNING = 'SQLite is an experimental feature';

/**
 * 递归收集 `src/` 下的 .ts 源文件路径。
 * @param dir 起始目录
 * @returns 绝对路径数组
 */
function tsFilesUnder(dir: string): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFilesUnder(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

test('① 结构：src 下不得值导入 node:sqlite（`import type` 允许；懒加载必须走 createRequire）', () => {
  const offenders: string[] = [];
  for (const file of tsFilesUnder(join(ROOT, 'src'))) {
    const text = readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      // 只看**值导入**：`import type {...} from 'node:sqlite'` 是编译期擦除的，留它是刻意的
      // （给 `typeof DatabaseSync` 类型用），故必须放行。
      if (!trimmed.startsWith('import ')) continue;
      if (trimmed.startsWith('import type')) continue;
      if (!trimmed.includes("'node:sqlite'")) continue;
      offenders.push(file.slice(ROOT.length + 1));
    }
  }
  assert.deepStrictEqual(
    offenders,
    [],
    `这些文件顶层值导入了 node:sqlite ⇒ 每条命令都会打 ExperimentalWarning：\n${offenders.join('\n')}`,
  );
});

test('② 实跑负对照：不碰 sqlite 的命令，stderr 不得含 SQLite 实验性警告', () => {
  // 三条代表性路径：`doctor`（诊断，最常被客户跑）/ `session list`（数据子命令）/ 未知旗标（错误路径）
  const cases: readonly string[][] = [['doctor'], ['session', 'list'], ['--definitely-not-a-flag']];
  for (const argv of cases) {
    const r = spawnSync(process.execPath, [CLI_ENTRY, ...argv], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
    });
    assert.ok(
      !`${r.stderr ?? ''}`.includes(WARNING),
      `${argv.join(' ')} 的 stderr 仍含「${WARNING}」：\n${r.stderr ?? ''}`,
    );
  }
});

test('③ 实跑正对照：真选 sqlite KV 时仍可写可读（懒加载未把功能改坏）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-sqlite-kv-'));
  const file = join(dir, 'kv.db');
  try {
    const set = spawnSync(
      process.execPath,
      [
        CLI_ENTRY,
        'kv',
        'set',
        '--key',
        'probe',
        '--value',
        'v1',
        '--kv-adapter',
        'sqlite',
        '--kv-file',
        file,
      ],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 },
    );
    assert.strictEqual(set.status, 0, `kv set 失败：${set.stdout ?? ''}${set.stderr ?? ''}`);
    const get = spawnSync(
      process.execPath,
      [CLI_ENTRY, 'kv', 'get', '--key', 'probe', '--kv-adapter', 'sqlite', '--kv-file', file],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 },
    );
    assert.strictEqual(get.status, 0, `kv get 失败：${get.stdout ?? ''}${get.stderr ?? ''}`);
    assert.match(`${get.stdout ?? ''}`, /v1/, '写入的值必须能读回（懒加载后功能不变）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
