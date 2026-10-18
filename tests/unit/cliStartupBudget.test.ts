/**
 * CLI 子命令启动成本的**回归判据**（目标 (9)「CLI 子命令启动 ~2s」，2026-10-11；2026-10-15 追加两段加载）。
 *
 * ## 修之前的实测与根因
 *
 * | 命令 | 修前 | 修后（分段加载前） | 修后（2026-10-15 两段加载） |
 * | --- | --- | --- | --- |
 * | `--version` | 140 ms | ~120 ms | ~120 ms（不走慢路径） |
 * | `kv list` | **1729 ms** | **~944 ms** | **~640 ms**（不再加载链顶） |
 *
 * 根因用 `--cpu-prof` 定位：**CPU 时间几乎全在 ESM 解析/编译**（`getPackageScopeConfig` 439ms、
 * `compileSourceTextModule` 209ms + 大量 stat/open），而我们自己的模块自身耗时≈0。
 * 第一轮把成本集中的**几个顶层值导入**改成方法内 `await import(...)`；第二轮（2026-10-15）
 * 让 `exec.ts` **先只加载链基半段**（`execLocal.js`：`CliDataCmds` 与其祖先），
 * 只有链顶命令与默认 agent 路径才加载 `execCli.js`——ESM 只加载被 import 的模块，而继承只**向上**依赖，
 * 故"先试链基"不会把链顶带进来。本机实测模块导入（含 ~75ms Node 启动）：链基 ≈710ms、整链 ≈990ms。
 *
 * ## 诚实边界
 *
 * 链基那 6 个类**仍是单继承**（本次只把**链顶**从本地命令路径上摘掉）；进一步的收益要按层拆，
 * 属独立一片（看板 §8.22 登记）。`license` / `capability` / `evolution` 仍走链顶。
 *
 * ## 判据口径
 *
 * | # | 判据 | 坏掉的后果 |
 * | --- | --- | --- |
 * | ① | 结构：四个重依赖**不得**在那些层里恢复成顶层值导入 | 有人改回去 ⇒ 启动成本悄悄回到 1.7s（无任何红） |
 * | ①-b | 结构：`exec.ts` 必须先试 `execLocal` 且**不得静态 import** `execCli` | 两段加载被悄悄改回一段，收益无声消失 |
 * | ② | 运行期：`kv list` 墙钟 ≤ 预算（3 次取中位数） | 结构对了但仍被别的顶层导入拖慢 |
 * | ③ | 正对照：`--version` 必须显著快于 `kv list`（比例），说明测量确实在量"装配成本"而非 Node 启动 | 若两者同速，②可能只是在量 Node 冷启动 |
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 仓库根（判据在 `dist/tests/unit/`）。 */
const REPO_ROOT = process.cwd();

/** 走真 CLI 入口跑一个子命令，返回墙钟毫秒。 */
function timeCli(args: readonly string[]): number {
  const started = Date.now();
  const result = spawnSync(process.execPath, [join(REPO_ROOT, 'dist/src/cli/exec.js'), ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, OMNI_REPO_MAP: '0' },
  });
  const elapsed = Date.now() - started;
  assert.strictEqual(result.status, 0, `CLI 命令 ${args.join(' ')} 未正常退出：${result.stderr}`);
  return elapsed;
}

/**
 * 取 n 次运行里的**最小值**（固定启动成本的最优估计）。
 *
 * 为什么不用中位数（2026-10-15 改）：本判据量的是**固定装配成本**，噪声只会把它抬高、不会压低，
 * 故最小值是最少受干扰的估计。实测同一份代码在中位数口径下几分钟内分别给出 12.41 与 4.12
 * （比值分母 `--version` 98ms↔216ms、分子 1216ms↔889ms 同步漂移）——中位数把负载噪声直接
 * 灌进了判据。**改的是估计量，不是预算**：阈值仍为 ≤10。
 * @param args 子命令参数
 * @param runs 次数
 * @returns 最小墙钟毫秒
 */
function bestOf(args: readonly string[], runs = 3): number {
  const samples = Array.from({ length: runs }, () => timeCli(args));
  return Math.min(...samples);
}

test('① 结构：重依赖不得在这些 CLI 层里恢复成顶层值导入（附正对照）', () => {
  /**
   * 检查一个文件里是否含某个顶层值导入。
   * @param file 相对仓库根的路径
   * @param pattern 顶层导入的正则
   * @returns 命中次数
   */
  function countStaticImports(file: string, pattern: RegExp): number {
    const source = readFileSync(join(REPO_ROOT, file), 'utf8');
    return [...source.matchAll(pattern)].length;
  }

  const checks: readonly { file: string; pattern: RegExp; why: string }[] = [
    {
      file: 'src/cli/cliBuildConfig.ts',
      // 2026-10-17 起源码相对导入写真实后缀 `.ts`，判据正则跟新（否则该条退化为恒真）。
      pattern: /^import \{ ConfigFactory \} from '\.\.\/config\/configFactory\.ts';$/gmu,
      why: 'ConfigFactory 净 ~580ms，而它只在 buildConfig 里用 ⇒ 必须留在方法内动态 import',
    },
    {
      file: 'src/cli/cliBuildConfig.ts',
      pattern: /^import \{ SdkPreferredMcpConnector \} from .*$/gmu,
      why: 'MCP connector 净 ~480ms，只在桥接 MCP 时用',
    },
    {
      file: 'src/cli/cliCompareCmds.ts',
      pattern: /^import \{ (Agent|Runtime|ConfigFactory) \} from .*$/gmu,
      why: 'compare 是冷门命令族，Agent+Runtime+ConfigFactory 合计 ~1.2s，不得被整链加载',
    },
    {
      file: 'src/cli/cliMcpCmds.ts',
      pattern: /^import \{ SdkPreferredMcpConnector \} from .*$/gmu,
      why: '同上（mcp 层），否则每个子命令都付 ~480ms',
    },
  ];
  for (const check of checks) {
    assert.strictEqual(
      countStaticImports(check.file, check.pattern),
      0,
      `${check.file} 又出现了顶层值导入：${check.pattern.source}\n理由：${check.why}`,
    );
  }

  // **正对照**：把一条顶层导入塞回去必须被检出（否则上面四条可能恒真——比如路径写错）。
  const sample = "import { ConfigFactory } from '../config/configFactory.ts';\n";
  const hits = [...sample.matchAll(checks[0]!.pattern)].length;
  assert.strictEqual(hits, 1, '正对照：样例顶层导入必须能被该正则命中');
  // 动态导入写法**不得**被误判（它是本轮的修法）。
  const dynamic = "const { ConfigFactory } = await import('../config/configFactory.ts');\n";
  assert.strictEqual([...dynamic.matchAll(checks[0]!.pattern)].length, 0, '动态导入不得被判红');
});

test('①-b 结构：`exec.ts` 必须先试链基分发，且**不得静态 import** 链顶（两段加载不得被改回一段）', () => {
  const execSource = readFileSync(join(REPO_ROOT, 'src/cli/exec.ts'), 'utf8');
  assert.match(
    execSource,
    /import\('\.\/execLocal\.ts'\)/u,
    'exec.ts 必须动态加载链基分发层（execLocal）——它才是本地命令少加载 ~280ms 的那一步',
  );
  assert.match(
    execSource,
    /await new ExecLocal\(\)\.runLocal\(argv\)/u,
    'exec.ts 必须**真的调用**链基分发（只 import 不调用等于没接线）',
  );
  assert.doesNotMatch(
    execSource,
    /^import .*from '\.\/execCli\.ts';$/gmu,
    'exec.ts 不得静态 import 链顶（execCli）——那会把整条链拉回每一条命令的冷启动路径',
  );
  assert.match(
    execSource,
    /await import\('\.\/execCli\.ts'\)/u,
    '链顶必须在链基不认识该命令时才被动态加载',
  );

  // `ExecLocal` 必须落在链基半段：它若去 import 链顶（或 Agent/Runtime），两段加载就白做了。
  const localSource = readFileSync(join(REPO_ROOT, 'src/cli/execLocal.ts'), 'utf8');
  assert.match(
    localSource,
    /class ExecLocal extends CliDataCmds/u,
    '链基分发层必须继承链基（CliDataCmds）',
  );
  assert.doesNotMatch(
    localSource,
    /from '\.\/execCli\.ts'|from '\.\.\/core\/agent\.ts'|from '\.\.\/composition\/runtime\.ts'/u,
    '链基分发层不得引入链顶/Agent/Runtime（那会让"先试链基"变成"其实还是整链"）',
  );

  // **正对照**：把 exec.ts 的一句改成静态 import ⇒ 上面的 doesNotMatch 必须抓得到（否则恒真）。
  const mutated = execSource.replace(
    "import('./execLocal.ts'),",
    "import('./execLocal.ts'),\nimport { ExecCli } from './execCli.ts';",
  );
  assert.notStrictEqual(mutated, execSource, '正对照变异未落地');
  assert.match(
    mutated,
    /^import .*from '\.\/execCli\.ts';$/gmu,
    '把链顶改成静态 import 后必须能被检出 ⇒ 否则①-b 恒真',
  );
});

test('② 运行期：`kv list` 的启动成本用**相对量**约束（比值 ≤ 10），不用绝对秒数', () => {
  // 为什么用比值：本判据会在**并发全量套件**里跑（几十个进程同时压机器），绝对毫秒会随负载整体上浮
  // ⇒ 修完也可能假红（首版就是 1500ms 绝对预算，在 28 文件并发下红）。本仓看板同一口径写着
  // 「耗时预算按并发墙钟或相对量，别用绝对秒数」。基准选 `--version`：同一个入口、同样的 Node 冷启动，
  // 但不做命令装配 ⇒ 比值只反映"装配成本"，且随负载同向变化。
  const version = bestOf(['--version']);
  const kvList = bestOf(['kv', 'list']);
  const ratio = kvList / Math.max(version, 1);
  process.stdout.write(
    `[cli-startup] --version = ${String(version)} ms ｜ kv list = ${String(kvList)} ms ｜ 比值 = ${ratio.toFixed(2)}\n`,
  );
  // 修前实测 1729/140 ≈ 12.3；第一轮后 859/117 ≈ 7.3；2026-10-15 两段加载后 ≈ 4–6（同机实测）。
  assert.ok(
    ratio <= 10,
    `kv list / --version = ${ratio.toFixed(2)} > 10 ⇒ 装配成本回到修前量级（修前 ~12.3 / 两段加载后 ~4–6）`,
  );
  // 绝对值只做病态回归兜底（极宽松，不参与精度判定）。
  assert.ok(kvList <= 5000, `kv list 启动 ${String(kvList)} ms 异常（>5s）`);
  assert.ok(version <= 800, `--version 启动 ${String(version)} ms 异常（>0.8s）`);
});

test('③ 正对照：`--version` 必须快于 `kv list`（否则②只是在量 Node 冷启动）', () => {
  const version = bestOf(['--version']);
  const kvList = bestOf(['kv', 'list']);
  assert.ok(
    kvList > version,
    `两条命令耗时相同（${String(kvList)} vs ${String(version)}）⇒ 说明 kv list 没在做装配工作，` +
      '本判据量错了对象',
  );
});
