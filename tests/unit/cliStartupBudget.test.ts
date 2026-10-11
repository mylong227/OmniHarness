/**
 * CLI 子命令启动成本的**回归判据**（目标 (9)「CLI 子命令启动 ~2s」，2026-10-11）。
 *
 * ## 修之前的实测与根因
 *
 * | 命令 | 修前 | 修后 |
 * | --- | --- | --- |
 * | `--version` | 140 ms | ~120 ms |
 * | `kv list` | **1729 ms** | **~944 ms** |
 *
 * 根因用 `--cpu-prof` 定位：**CPU 时间几乎全在 ESM 解析/编译**（`getPackageScopeConfig` 439ms、
 * `compileSourceTextModule` 209ms + 大量 stat/open），而我们自己的模块自身耗时≈0。
 * 逐层量模块导入发现成本集中在继承链上的**几个顶层值导入**：
 * `cliBuildConfig` 的 `configFactory`(净 ~580ms) 与 `sdkPreferredMcpConnector`(净 ~480ms)、
 * `cliCompareCmds` 的 `Agent`+`Runtime`+`configFactory`(合计 ~1.2s)、`cliMcpCmds` 的同名重依赖 ——
 * 而这条链是**单继承**（`CliCredentialBuild ← CliBuildConfig ← CliServerCmds ← … ← ExecCli`），
 * 于是**每个**子命令（含 `kv list` 这种纯本地命令）都要为它们的模块图付 ESM 解析成本。
 *
 * ## 本轮做了什么 / 没做什么（诚实边界）
 *
 * 做：把这些**只在特定方法里用到**的重依赖改成方法内 `await import(...)`（调用方零改动）。
 * 没做：**没有**打破单继承链本身——那是一次大改（组合替代继承），仍是登记在案的后续项。
 * 因此 `kv list` 仍有 ~0.9s：其中 ~0.55s 是 `cliServerCmds` 这一层自身的模块图（链的基部）。
 *
 * ## 判据口径
 *
 * | # | 判据 | 坏掉的后果 |
 * | --- | --- | --- |
 * | ① | 结构：四个重依赖**不得**在那些层里恢复成顶层值导入 | 有人改回去 ⇒ 启动成本悄悄回到 1.7s（无任何红） |
 * | ② | 运行期：`kv list` 墙钟 ≤ 预算（3 次取中位数） | 结构对了但仍被别的顶层导入拖慢 |
 * | ③ | 正对照：`--version` 必须显著快于 `kv list`（比例），说明测量确实在量"装配成本"而非 Node 启动 | 若两者同速，②可能只是在量 Node 冷启动 |
 */
import { test } from 'node:test';
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

/** 取 n 次运行的中位数（抗抖动）。 */
function medianOf(args: readonly string[], runs = 3): number {
  const samples = Array.from({ length: runs }, () => timeCli(args)).sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)] ?? Number.MAX_SAFE_INTEGER;
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
      pattern: /^import \{ ConfigFactory \} from '\.\.\/config\/configFactory\.js';$/gmu,
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
  const sample = "import { ConfigFactory } from '../config/configFactory.js';\n";
  const hits = [...sample.matchAll(checks[0]!.pattern)].length;
  assert.strictEqual(hits, 1, '正对照：样例顶层导入必须能被该正则命中');
  // 动态导入写法**不得**被误判（它是本轮的修法）。
  const dynamic = "const { ConfigFactory } = await import('../config/configFactory.js');\n";
  assert.strictEqual([...dynamic.matchAll(checks[0]!.pattern)].length, 0, '动态导入不得被判红');
});

test('② 运行期：`kv list` 的启动成本用**相对量**约束（比值 ≤ 10），不用绝对秒数', () => {
  // 为什么用比值：本判据会在**并发全量套件**里跑（几十个进程同时压机器），绝对毫秒会随负载整体上浮
  // ⇒ 修完也可能假红（首版就是 1500ms 绝对预算，在 28 文件并发下红）。本仓看板同一口径写着
  // 「耗时预算按并发墙钟或相对量，别用绝对秒数」。基准选 `--version`：同一个入口、同样的 Node 冷启动，
  // 但不做命令装配 ⇒ 比值只反映"装配成本"，且随负载同向变化。
  const version = medianOf(['--version']);
  const kvList = medianOf(['kv', 'list']);
  const ratio = kvList / Math.max(version, 1);
  process.stdout.write(
    `[cli-startup] --version = ${String(version)} ms ｜ kv list = ${String(kvList)} ms ｜ 比值 = ${ratio.toFixed(2)}\n`,
  );
  // 修前实测 1729/140 ≈ 12.3；修后 859/117 ≈ 7.3（同一台机器）。
  assert.ok(
    ratio <= 10,
    `kv list / --version = ${ratio.toFixed(2)} > 10 ⇒ 装配成本回到修前量级（修前 ~12.3 / 修后 ~7.3）`,
  );
  // 绝对值只做病态回归兜底（极宽松，不参与精度判定）。
  assert.ok(kvList <= 5000, `kv list 启动 ${String(kvList)} ms 异常（>5s）`);
  assert.ok(version <= 800, `--version 启动 ${String(version)} ms 异常（>0.8s）`);
});

test('③ 正对照：`--version` 必须快于 `kv list`（否则②只是在量 Node 冷启动）', () => {
  const version = medianOf(['--version']);
  const kvList = medianOf(['kv', 'list']);
  assert.ok(
    kvList > version,
    `两条命令耗时相同（${String(kvList)} vs ${String(version)}）⇒ 说明 kv list 没在做装配工作，` +
      '本判据量错了对象',
  );
});
