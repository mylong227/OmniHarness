/**
 * 一键启动的**就绪探针 / 端口解析 / 外壳命令 / 退出文案**判据（2026-10-13）。
 *
 * ## 它盯的是什么
 *
 * 新增「双击即起 + 就绪后自动开浏览器」（`start.cmd` → `scripts/startAll.mjs --open`）后，
 * 这个便利功能有三种**骗人**的形态，全都以"看起来像 bug"收场：
 *
 * | # | 骗法 | 后果 |
 * | --- | --- | --- |
 * | ① | 只看"端口有没有人听"就开浏览器 | 端口上其实是**别的进程**（两天前的旧 serve / 别人的 HTTP 服务）⇒ 打开的是别人的页面 |
 * | ② | 用 `/healthz`（恒 200）当就绪判据 | 进程刚起来、核心组件还没齐就开 ⇒ **白屏**，用户以为前端坏了 |
 * | ③ | 等待超时后静默收场 | 双击了却"什么都没发生"，比不提供这个功能更难排查 |
 *
 * 另有两条**漂移**必须钉死：端口缺省值（`serve` 权威实现是 `src/cli/cliServerCmds.ts` 的
 * `--port ?? 8787`，启动器不得自成一源）与「`--open` 绝不能透传给 serve」
 * （serve 对未知旗标 fail-closed ⇒ 便利功能会把它自己打死）。
 *
 * 判据全在离线机器上真跑（注入 `probe`/`sleep`/`now`，不联网、不真等待）。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 仓库根（判据脚本自身在 `dist/tests/unit/`，而 `scripts/` 不参与编译 ⇒ 按 cwd 解析）。 */
const REPO_ROOT = process.cwd();

/** 一次就绪探测的观测结果。 */
interface ProbeInput {
  readonly statusCode?: number;
  readonly bodyText?: string;
  readonly error?: unknown;
}

/** 就绪标签。 */
type ReadyKind = 'down' | 'degraded' | 'ready' | 'guarded' | 'foreign';

/** 被判据盯着的启动器模块形状。 */
interface LaunchReadinessModule {
  readonly DEFAULT_SERVE_PORT: number;
  readonly resolveServePort: (args: readonly string[]) => number;
  readonly readinessUrl: (port: number) => string;
  readonly classifyReadyProbe: (input: ProbeInput) => ReadyKind;
  readonly waitForReady: (options: {
    probe: () => Promise<ReadyKind>;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    pollMs?: number;
    timeoutMs?: number;
  }) => Promise<{ outcome: string; attempts: number; lastKind: string }>;
  readonly describeReadyOutcome: (outcome: string, port: number) => string;
  readonly describeServeExit: (code: number | null | undefined) => string;
  readonly browserOpenCommand: (
    platform: string,
    url: string,
  ) => { command: string; args: readonly string[] } | null;
}

/**
 * 载入 `scripts/lib/launchReadiness.mjs`。
 *
 * 用**按 cwd 解析的动态 import** 而不是相对字面量：该模块是脚本侧原生 ESM，
 * 不参与 tsc 编译（`dist/scripts/**` 不存在），故 `dist/tests/**` 里的相对路径必然解析失败。
 * @returns 模块导出（形状见上）。
 */
async function loadModule(): Promise<LaunchReadinessModule> {
  const url = pathToFileURL(join(REPO_ROOT, 'scripts', 'lib', 'launchReadiness.mjs')).href;
  const mod = (await import(url)) as LaunchReadinessModule;
  return mod;
}

/** 启动入口脚本源码（接线判据用）。 */
function startAllSource(): string {
  return readFileSync(join(REPO_ROOT, 'scripts', 'startAll.mjs'), 'utf8');
}

test('① 端口解析：两种写法都认，非法/缺失一律回落缺省（不得猜）', async () => {
  const { resolveServePort, DEFAULT_SERVE_PORT } = await loadModule();
  assert.strictEqual(resolveServePort(['--port', '9000']), 9000);
  assert.strictEqual(resolveServePort(['--port=9000']), 9000);
  assert.strictEqual(resolveServePort([]), DEFAULT_SERVE_PORT);
  assert.strictEqual(resolveServePort(['--mock']), DEFAULT_SERVE_PORT);
  // 非法形态：非数字 / 0 / 越界 / 只给了旗标没给值 ⇒ 回落缺省（宁可探错端口并给可读超时提示，
  // 也不在启动器里复刻一套旗标校验——那是第二份真相）。
  assert.strictEqual(resolveServePort(['--port', 'abc']), DEFAULT_SERVE_PORT);
  assert.strictEqual(resolveServePort(['--port', '0']), DEFAULT_SERVE_PORT);
  assert.strictEqual(resolveServePort(['--port=70000']), DEFAULT_SERVE_PORT);
  assert.strictEqual(resolveServePort(['--port']), DEFAULT_SERVE_PORT);
  // 正对照：合法值必须**真的**被读出来（否则上面那串"回落缺省"全都在恒真通过）。
  assert.notStrictEqual(resolveServePort(['--port', '9000']), DEFAULT_SERVE_PORT);
});

test('② 端口缺省值不得自成一源：必须与 serve 权威实现一致', async () => {
  const { DEFAULT_SERVE_PORT } = await loadModule();
  const source = readFileSync(join(REPO_ROOT, 'src', 'cli', 'cliServerCmds.ts'), 'utf8');
  const found = /--port'\s*\)\s*\?\?\s*(\d+)/u.exec(source);
  assert.ok(
    found !== null,
    '没在 src/cli/cliServerCmds.ts 里找到 `--port` 的缺省值写法（正则需同步）⇒ 本判据已失效，请更新',
  );
  assert.strictEqual(
    DEFAULT_SERVE_PORT,
    Number(found[1]),
    '启动器的缺省端口与 serve 的权威缺省值漂移了：改一处必须改两处，或让启动器读同一源头',
  );
});

test('③ 就绪分类穷尽且 fail-closed：非本程序的响应绝不判就绪', async () => {
  const { classifyReadyProbe } = await loadModule();
  const healthBody = JSON.stringify({ status: 'ok', uptimeSeconds: 1, pid: 1, checks: {} });

  assert.strictEqual(classifyReadyProbe({ statusCode: 200, bodyText: healthBody }), 'ready');
  assert.strictEqual(
    classifyReadyProbe({ statusCode: 503, bodyText: healthBody.replace('"ok"', '"degraded"') }),
    'degraded',
    '503/degraded 属"起来了但没就绪"⇒ 继续等，不是失败',
  );
  assert.strictEqual(classifyReadyProbe({ error: new Error('ECONNREFUSED') }), 'down');
  assert.strictEqual(classifyReadyProbe({ statusCode: 401, bodyText: '' }), 'guarded');

  // fail-closed 的关键负例：**有响应**但认不出是本程序的健康体 ⇒ foreign，绝不乐观判就绪。
  assert.strictEqual(
    classifyReadyProbe({ statusCode: 200, bodyText: '<html>hi</html>' }),
    'foreign',
  );
  assert.strictEqual(classifyReadyProbe({ statusCode: 200, bodyText: '{}' }), 'foreign');
  assert.strictEqual(classifyReadyProbe({ statusCode: 404, bodyText: 'nope' }), 'down');
  assert.strictEqual(classifyReadyProbe({}), 'down', '观测本身不可信时按"没起来"处理');

  // 正对照：把健康体喂进去必须**不是** foreign（否则"分类器"等于常量）。
  assert.notStrictEqual(classifyReadyProbe({ statusCode: 200, bodyText: healthBody }), 'foreign');
});

test('④ 就绪轮询：等到 ready 才收工；一直不就绪则以超时收场（不无限循环）', async () => {
  const { waitForReady } = await loadModule();
  let clock = 0;
  const now = (): number => clock;
  const sleep = async (ms: number): Promise<void> => {
    clock += ms;
  };

  // 前两次"没起来"、第三次就绪 ⇒ 恰好三次尝试后返回 ready。
  const seen: ReadyKind[] = ['down', 'down', 'ready'];
  let index = 0;
  const ready = await waitForReady({
    probe: async () => seen[Math.min(index++, seen.length - 1)]!,
    sleep,
    now,
    pollMs: 10,
    timeoutMs: 1000,
  });
  assert.strictEqual(ready.outcome, 'ready');
  assert.strictEqual(ready.attempts, 3, '已就绪还继续轮询 = 白等');

  // 一直不就绪 ⇒ 以 timeout 收场，且尝试次数可精确预期（这条同时防"死循环"）。
  clock = 0;
  const stuck = await waitForReady({
    probe: async () => 'down',
    sleep,
    now,
    pollMs: 10,
    timeoutMs: 50,
  });
  assert.strictEqual(stuck.outcome, 'timeout');
  assert.strictEqual(stuck.attempts, 6, '超时分支的节奏与预算必须可预期（50ms 预算 / 10ms 一步）');

  // foreign 是**终局**：端口上是别人 ⇒ 立刻停，不许继续轮询（否则会一直等到超时再报错）。
  let calls = 0;
  const foreign = await waitForReady({
    probe: async () => {
      calls += 1;
      return 'foreign';
    },
    sleep,
    now,
    pollMs: 10,
    timeoutMs: 1000,
  });
  assert.strictEqual(foreign.outcome, 'foreign');
  assert.strictEqual(calls, 1, '认出卖家不是本程序后仍继续轮询 ⇒ 又变成"静默等到超时"');
});

test('⑤ 打开浏览器的系统命令：Windows 必须给窗口标题占位参数', async () => {
  const { browserOpenCommand } = await loadModule();
  const url = 'http://127.0.0.1:8787';
  const win = browserOpenCommand('win32', url);
  assert.ok(win !== null, 'Windows 是本仓的主要目标平台，不得返回 null');
  assert.strictEqual(win.command, 'cmd');
  assert.deepStrictEqual(win.args, ['/c', 'start', '', url]);
  assert.strictEqual(win.args[2], '', '缺窗口标题占位符时，带查询串的 URL 会被 start 当成标题');
  assert.strictEqual(browserOpenCommand('darwin', url)?.command, 'open');
  assert.strictEqual(browserOpenCommand('linux', url)?.command, 'xdg-open');
  assert.strictEqual(browserOpenCommand('freebsd', url), null, '不认识的平台必须如实返回 null');
});

test('⑥ 退出文案：Ctrl+C 与失败必须分得开（双击场景里这是唯一线索）', async () => {
  const { describeServeExit } = await loadModule();
  assert.match(describeServeExit(130), /Ctrl\+C/u);
  assert.match(describeServeExit(3221225786), /Ctrl\+C/u, 'Windows 控制台的 NTSTATUS 口径也要认');
  assert.match(describeServeExit(0), /正常结束/u);
  assert.match(describeServeExit(1), /退出码 1/u);
  assert.match(describeServeExit(1), /构建|端口/u, '失败文案必须给出下一步，而不是只说"失败了"');
  assert.doesNotMatch(describeServeExit(1), /Ctrl\+C/u, '把失败说成 Ctrl+C 会掩盖真故障');
  assert.match(describeServeExit(null), /信号/u);
});

test('⑦ 接线：`--open` 由本脚本消费、绝不透传给 serve（未知旗标 fail-closed）', async () => {
  const source = startAllSource();
  assert.match(source, /args\.includes\('--open'\)/u, '--open 必须被启动入口识别');
  assert.match(
    source,
    /a !== '--no-build' && a !== '--open'/u,
    'serveArgs 过滤必须同时剔除 --open：透传会被 serve 的未知旗标 fail-closed 打死',
  );
  assert.match(
    source,
    /void openWhenReady\(resolveServePort\(serveArgs\), uiUrlRef\)/u,
    '--open 分支必须真的被调用，并把带 token 的 uiUrlRef 传进去（裸 URL 会 401）',
  );
  assert.match(
    source,
    /describeServeExit\(code\)/u,
    '退出码必须经可读文案打印（否则双击窗口一关就没线索）',
  );
  assert.match(source, /'\/readyz'|readinessUrl/u, '就绪判据必须走 /readyz 这条链');
});

test('⑧ 无人值守开关：`OMNI_NO_OPEN=1` 压住弹窗，但**不**压住「等待并就绪报告」', async () => {
  const source = startAllSource();
  assert.match(source, /OMNI_NO_OPEN === '1'/u, 'OMNI_NO_OPEN 必须被读取并参与判定');
  assert.match(
    source,
    /已就绪但未打开浏览器/u,
    '压住弹窗时必须如实报告"已就绪"，否则自动化里拿不到"起来了没"这个事实',
  );
  // 关键顺序判据：压住弹窗的分支必须**排在** spawn 之前，且**排在** waitForReady 之后。
  // 把 waitForReady 一起跳过 = 顺带把"就绪"这个唯一有价值的信息也丢了。
  const waitAt = source.indexOf('await waitForReady(');
  const suppressAt = source.indexOf("OMNI_NO_OPEN === '1'");
  const spawnAt = source.indexOf('browserOpenCommand(process.platform, page)');
  assert.ok(waitAt > 0 && suppressAt > 0 && spawnAt > 0, '三处锚点必须都能在源码里找到');
  assert.ok(waitAt < suppressAt, '无关开关必须在等待之后就绪判定之后才生效');
  assert.ok(suppressAt < spawnAt, '压住弹窗的分支必须在真正 spawn 之前 return');
});
