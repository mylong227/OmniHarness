/**
 * 「跳过即假绿」的**机制判据 + 全仓清点**（2026-10-11）。
 *
 * ## 它解决什么
 *
 * 本仓有 14 个文件含 skip 点，其中 10 个此前是**无开关的静默跳过**：缺原生内核 / 缺 wasm 产物 /
 * 没装 `sharp` / 没有 Laya 权重时，那些用例在 CI 上**看着绿、其实一行没跑**（浏览器一族早有
 * `OMNI_REQUIRE_BROWSER=1`，其余没有）。本轮把开关收进 `tests/helpers/requireEnv.ts` 并逐个接上。
 *
 * ## 两条判据
 *
 * ① **机制自证**：直接验 `RequireEnv` 的三种语义（可用⇒照跑 / 不可用且开关关⇒跳过 /
 *    不可用且开关开⇒**失败**）。为什么必须单独验它：本机恰好**什么能力都在**（连 `dsh` 都在 PATH），
 *    所以"给某个文件开开关"这种端到端正对照在这台机器上**无法区分真假**——只能验机制本身。
 * ② **全仓清点**：扫 `tests/**` 的 skip 点，要求每个文件要么引用某个 `OMNI_REQUIRE_*` 开关，
 *    要么在**显式豁免表**里（平台语义 / 两侧分支都有用例）。新增一个静默跳过 ⇒ 当场红。
 *    另加"开关表不得有死条目"：每个登记的开关都必须真的被某个测试文件引用。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PLATFORM_SKIP_EXEMPT_FILES,
  REQUIRE_SWITCHES,
  RequireEnv,
  type RequireSwitch,
} from '../helpers/requireEnv.ts';

/** 仓库根（编译产物在 `dist/tests/unit/`）。 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * 递归收集 `tests/**` 下的 .ts（非 .d.ts）**以及 `web/test/**` 下的 .ts**。
 *
 * 2026-10-11（F8 那轮补的洞）：扫描面此前只有 `tests/**` ⇒ **web 侧的浏览器类判据不在管辖内**，
 * 它们可以 `t.skip('未找到本机 Chrome/Edge')` 静默跳过而没人管——正是"跳过即假绿"。
 * 现把 web 侧一并纳入；机制实现自身（`browserSwitch.ts`）豁免。
 * 2026-10-17（测试栈统一）：web 判据从 .mjs 迁 .ts，扫描后缀同步改为 `.ts`。
 * @returns 相对仓库根的路径列表（升序）
 */
function testSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string, accept: (name: string) => boolean): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs, accept);
      else if (accept(entry.name)) {
        out.push(relative(REPO_ROOT, abs).split(sep).join('/'));
      }
    }
  };
  walk(join(REPO_ROOT, 'tests'), (name) => name.endsWith('.ts') && !name.endsWith('.d.ts'));
  walk(join(REPO_ROOT, 'web', 'test'), (name) => name.endsWith('.ts'));
  return out.sort();
}

/**
 * 判定"这一行是不是一个跳过点"。
 *
 * 三种既有写法：`t.skip(` / `{ skip: … }` / 探针的 `SKIP: ` 文本 + `return 0`
 * （探针不是 node:test 文件，跳过表现为打印 SKIP 后正常退出）。
 */
const SKIP_PATTERN = /\bt\.skip\(|\{\s*skip:|\)\s*,\s*\{\s*skip:|SKIP: /;

/** 非测试的助手实现（它自己含 `t.skip(` 调用，是机制的实现而非跳过点）。 */
const HELPER_IMPL = 'tests/helpers/requireEnv.ts';

test('① 机制自证：可用⇒照跑 / 不可用且开关关⇒跳过 / 不可用且开关开⇒失败', () => {
  const name: RequireSwitch = 'OMNI_REQUIRE_NATIVE';
  // 可用：两种形态都放行
  assert.strictEqual(RequireEnv.skipUnless(name, true, '不可用'), false);
  assert.strictEqual(
    RequireEnv.guardUnless({ skip: () => assert.fail('不该跳过') }, name, true, '不可用'),
    true,
  );
  // 开关关闭 + 不可用：如实跳过（不是静默通过）
  const saved = process.env[name];
  try {
    delete process.env[name];
    assert.strictEqual(RequireEnv.skipUnless(name, false, '缺 X'), '缺 X');
    const skipped: string[] = [];
    assert.strictEqual(
      RequireEnv.guardUnless({ skip: (reason) => skipped.push(reason) }, name, false, '缺 X'),
      false,
    );
    assert.deepStrictEqual(skipped, ['缺 X'], '必须真的调用 t.skip 并带上原因');

    // 开关打开 + 不可用：两种形态都必须**失败**（这才是"拒绝假绿"的那一下）
    process.env[name] = '1';
    assert.throws(() => RequireEnv.skipUnless(name, false, '缺 X'), /OMNI_REQUIRE_NATIVE=1/);
    assert.throws(
      () => RequireEnv.guardUnless({ skip: () => assert.fail('不该跳过') }, name, false, '缺 X'),
      /OMNI_REQUIRE_NATIVE=1/,
    );
    // 开关取值必须是严格 '1'（`OMNI_REQUIRE_X=0` 不得被当成开启）
    process.env[name] = '0';
    assert.strictEqual(RequireEnv.isOn(name), false, "只有 ='1' 才算开启");
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
});

test('② 全仓清点：每个 skip 点所在的文件必须接上开关，或在显式豁免表里', () => {
  const offenders: string[] = [];
  let scanned = 0;
  let skipFiles = 0;
  let webSkipFiles = 0;
  for (const rel of testSources()) {
    scanned += 1;
    if (rel === HELPER_IMPL) continue;
    const text = readFileSync(join(REPO_ROOT, rel), 'utf8');
    if (!SKIP_PATTERN.test(text)) continue;
    skipFiles += 1;
    if (rel.startsWith('web/test/')) webSkipFiles += 1;
    // 开关的三种合法写法：TS 侧常量名、web 侧的 `requireBrowser()`、或显式 `skipReasonFor(`。
    const hasSwitch =
      /OMNI_REQUIRE_[A-Z_]+/.test(text) ||
      /requireBrowser\(\)/.test(text) ||
      /skipReasonFor\(/.test(text);
    const exempt: readonly string[] = PLATFORM_SKIP_EXEMPT_FILES;
    if (!hasSwitch && !exempt.includes(rel)) {
      offenders.push(rel);
    }
  }
  // 仪器自证：扫描面必须非空，且确实扫到了 skip 点（否则"零违规"只是因为没扫到东西）
  assert.ok(scanned >= 50, `扫描面过小（${String(scanned)} 个测试源文件）⇒ 判据没覆盖真实仓库`);
  assert.ok(skipFiles >= 8, `只扫到 ${String(skipFiles)} 个含 skip 的文件 ⇒ 判据的识别面可能失效`);
  // 2026-10-11：web 侧必须**真的**在扫描面内（首版只管 tests/** ⇒ 8 个 web 文件静默跳过无人管）。
  assert.ok(
    webSkipFiles >= 6,
    `只扫到 ${String(webSkipFiles)} 个含 skip 的 web 文件 ⇒ web/test 的扫描面可能失效`,
  );
  assert.deepStrictEqual(
    offenders,
    [],
    `这些文件的跳过**没有开关**（缺环境即静默不跑 = 看着绿）⇒ 接上 RequireEnv / browserSwitch，` +
      `或说明它为什么不属"能力缺失"并加进 PLATFORM_SKIP_EXEMPT_FILES：\n${offenders.join('\n')}`,
  );
  process.stdout.write(
    `[skip 清点] 扫描 ${String(scanned)} 个测试源文件 ｜ 含 skip 点 ${String(skipFiles)} 个文件` +
      `（其中 web ${String(webSkipFiles)} 个）｜ 豁免 ${String(PLATFORM_SKIP_EXEMPT_FILES.length)} 个 ｜ 无开关 0 个\n`,
  );
});

test('③ 开关表不得有死条目：每个登记的开关都必须真的被引用', () => {
  const corpus = testSources()
    .filter((rel) => rel !== HELPER_IMPL)
    .map((rel) => readFileSync(join(REPO_ROOT, rel), 'utf8'))
    .join('\n');
  const dead = Object.keys(REQUIRE_SWITCHES).filter((name) => !corpus.includes(name));
  assert.deepStrictEqual(
    dead,
    [],
    `这些开关全仓无人引用 ⇒ 要么删掉，要么把对应能力的跳过接上它：${dead.join(', ')}`,
  );
});

test('④ 仓库根判定自洽（防 `tests/**` 扫描面静默塌缩）', () => {
  const testsDir = join(REPO_ROOT, 'tests');
  assert.ok(statSync(testsDir).isDirectory(), `tests 目录不存在：${testsDir}`);
  assert.ok(testSources().includes('tests/helpers/requireEnv.ts'), '扫描面应含机制实现文件本身');
});

/** CI 工作流原文（判据⑤的检体）。 */
function ciWorkflow(): string {
  return readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
}

/** 从给定的 ci.yml 文本里算出「既没接线、也没登记原因」的开关。 */
function unwiredSwitches(ci: string): string[] {
  const blockAt = ci.indexOf('CI 不可满足的开关');
  const block = blockAt < 0 ? '' : ci.slice(blockAt);
  return Object.keys(REQUIRE_SWITCHES).filter(
    (name) => !new RegExp(`${name}:`, 'u').test(ci) && !block.includes(name),
  );
}

test('⑤ CI 接线：每个开关要么在 ci.yml 里打开，要么登记「CI 不可满足」的原因', () => {
  const ci = ciWorkflow();
  assert.ok(
    ci.includes('CI 不可满足的开关'),
    'ci.yml 缺「CI 不可满足的开关」登记段 —— 没这段就无法区分"没接线"与"接了但环境不具备"',
  );
  const unwired = unwiredSwitches(ci);
  assert.deepStrictEqual(
    unwired,
    [],
    `这些开关既没接进 CI、也没登记不可满足的原因 ⇒ "装了开关却没接进 CI"= 假绿仍在：\n${unwired.join('\n')}`,
  );

  // **正对照**：把某条接线删掉，同一函数必须能检出来（否则"零违规"可能只是函数恒空）。
  const mutated = ci.replace(/OMNI_REQUIRE_SHARP: '1'/, '');
  assert.notStrictEqual(mutated, ci, '正对照变异未命中 ⇒ 判据锚点漂了，先修本判据');
  assert.ok(
    unwiredSwitches(mutated).includes('OMNI_REQUIRE_SHARP'),
    '删掉 OMNI_REQUIRE_SHARP 的接线却检不出来 ⇒ 判据⑤是恒真断言',
  );
});

test('⑤b wasm 作业的接线必须**真跑**那三个单测（挂个环境变量不算接线）', () => {
  const ci = ciWorkflow();
  const wasmAt = ci.indexOf('\n  wasm:');
  assert.ok(wasmAt > 0, 'ci.yml 里找不到 wasm 作业');
  const wasmJob = ci.slice(wasmAt);
  assert.match(wasmJob, /OMNI_REQUIRE_WASM: '1'/, 'wasm 作业必须打开 OMNI_REQUIRE_WASM');
  for (const file of ['wasmKernelE2E', 'wasmSkillPack', 'wasmResourceLimits']) {
    assert.ok(
      wasmJob.includes(`${file}.test.js`),
      `wasm 作业必须真跑 ${file}.test.js —— 只设环境变量而不跑该文件，开关等于没接`,
    );
  }
});
