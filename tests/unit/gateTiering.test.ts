/**
 * **门禁分层**的结构判据（G27/TS3，2026-10-03 第十六轮）。
 *
 * ## 它锁的是什么
 *
 * 报告判据（"typed 规则后 `tsc`+typed eslint ≤45 s 且 `eslint .` <65 s"）是**耗时**判据，
 * 由 `scripts/gateBudget.mjs` 实测断言（本文件不重复测量——那样 `npm test` 会慢 45 s）。
 * 本文件锁的是**结构**，即"分层这件事没被悄悄做假"：
 *
 * | # | 判据 |
 * | --- | --- |
 * | ① | `runGates.mjs` 里**每一条门禁都声明了 tier**，且只取 `fast`/`typed` 两个合法值 |
 * | ② | 类型层门禁**必须**是"需要类型信息才能判"的那几条（`tsc` + 类型感知 eslint），不能塞普通脚本 |
 * | ③ | 快层层里**不得**出现需要类型信息的门禁（否则提交会变慢、且分层名不副实） |
 * | ④ | 类型感知 eslint 配置**确实**开了 `parserOptions.project`（没有它，typed 规则会**静默退化成空转**） |
 * | ⑤ | 类型感知层的规则集**逐字**等于策略清单（`TYPED_ONLY_RULES`）——多一条普通规则、少一条真需要类型的规则都算漂移 |
 * | ⑥ | 预算常量就是报告口径（65 s / 45 s），且被 `gateBudget.mjs` 引用（不是两处各写一份） |
 * | ⑦ | 基础 eslint 配置**不含**类型信息（快层之所以快的前提） |
 * | ⑧ | `--only` 点到的门禁**必须真的会跑**：跨层（或任何原因）被静默丢弃即红——`--only=tsc` 曾**零门禁 + 打印通过**、`--only=iron-law,tsc` 曾静默丢掉 tsc |
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

/** 仓库根（测试固定从仓库根运行；编译产物在 `dist/` 下，故必须按根算绝对路径）。 */
const ROOT = process.cwd();

/**
 * 按绝对路径导入根目录/脚本目录下的 `.mjs`（配置与策略模块不在 `dist/` 里，相对导入会解析失败）。
 * @param rel 相对仓库根的路径。
 * @returns 模块命名空间（调用方自行断言形状）。
 */
async function importRoot(rel: string): Promise<Record<string, unknown>> {
  return (await import(pathToFileURL(join(ROOT, rel)).href)) as Record<string, unknown>;
}

const policy = await importRoot('scripts/gateBudgetPolicy.mjs');
const FAST_BUDGET_SECONDS = policy['FAST_BUDGET_SECONDS'] as number;
const TYPED_BUDGET_SECONDS = policy['TYPED_BUDGET_SECONDS'] as number;
const GATE_TIERS = policy['GATE_TIERS'] as readonly string[];
const TYPED_ONLY_RULES = policy['TYPED_ONLY_RULES'] as readonly string[];
const TYPED_CONFIG_FILE = policy['TYPED_CONFIG_FILE'] as string;
const baseConfig = (await importRoot('eslint.config.mjs'))['default'] as readonly {
  readonly files?: readonly string[];
  readonly languageOptions?: { readonly parserOptions?: Readonly<Record<string, unknown>> };
}[];
const typedConfig = (await importRoot('eslint.typed.config.mjs'))['default'] as readonly {
  readonly files?: readonly string[];
  readonly languageOptions?: { readonly parserOptions?: Readonly<Record<string, unknown>> };
  readonly rules?: Readonly<Record<string, unknown>>;
}[];

/** 读仓库内文本文件。 */
function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

/**
 * 从 `runGates.mjs` 源码里抽出每条门禁的 `{id, tier}`。
 *
 * 这里读源码而非 import：`runGates.mjs` 一被 import 就会**执行门禁**（顶层即跑），
 * 不能作为模块引用。故用窄正则只取 `id`/`tier` 两个字段。
 * @returns 门禁 id 与 tier 的配对列表。
 */
function gateEntries(): { readonly id: string; readonly tier: string | undefined }[] {
  const src = read('scripts/runGates.mjs');
  const out: { id: string; tier: string | undefined }[] = [];
  for (const block of src.matchAll(/id:\s*'([^']+)',\s*\n\s*tier:\s*'?([^',\n]*)'?,?/g)) {
    out.push({ id: block[1]!, tier: block[2]?.trim() });
  }
  return out;
}

test('① 每条门禁都声明 tier，且取值合法（无 tier = 会被静默归错层的门禁）', () => {
  const src = read('scripts/runGates.mjs');
  const ids = [...src.matchAll(/id:\s*'([^']+)',/g)].map((m) => m[1]!);
  const entries = gateEntries();
  assert.strictEqual(
    entries.length,
    ids.length,
    `${String(ids.length)} 条门禁里只有 ${String(entries.length)} 条声明了 tier：漏声明的那条会悄悄落进错误层`,
  );
  for (const gate of entries) {
    assert.ok(
      GATE_TIERS.includes(gate.tier ?? ''),
      `门禁 ${gate.id} 的 tier=${String(gate.tier)} 不在 ${GATE_TIERS.join('/')} 内`,
    );
  }
});

test('② 类型层里必须是"需要类型信息"的门禁（tsc + 类型感知 eslint）', () => {
  const typed = gateEntries()
    .filter((g) => g.tier === 'typed')
    .map((g) => g.id)
    .sort();
  assert.deepStrictEqual(
    typed,
    ['eslint-typed', 'tsc'],
    '类型层只应放这两条：其余判定都不需要类型信息，放进来只会白付建程序的代价',
  );
});

test('③ 快层里不得混入类型层门禁（保证提交门禁的耗时不被拖垮）', () => {
  const fast = gateEntries().filter((g) => g.tier === 'fast');
  assert.ok(fast.length >= 10, `快层门禁数异常（${String(fast.length)}），疑似有门禁漏了 tier`);
  for (const gate of fast) {
    assert.ok(!['tsc', 'eslint-typed'].includes(gate.id), `${gate.id} 不该在快层`);
  }
});

test('④ 类型感知配置确实开了 parserOptions.project（否则 typed 规则会静默空转）', () => {
  const entries = typedConfig as readonly {
    readonly files?: readonly string[];
    readonly languageOptions?: { readonly parserOptions?: { readonly project?: unknown } };
    readonly rules?: Readonly<Record<string, unknown>>;
  }[];
  const typedScope = entries.find((e) => e.languageOptions?.parserOptions?.project !== undefined);
  assert.ok(
    typedScope !== undefined,
    '没有任何一条配置项给出 parserOptions.project ⇒ 类型感知规则拿不到类型，等于没开',
  );
  assert.deepStrictEqual(
    typedScope.files,
    ['src/**/*.ts'],
    '类型层的作用域应是 src/**（测试与脚本不需要付这份代价）',
  );
});

test('⑤ 类型层的规则集逐字等于策略清单（多一条普通规则 / 少一条真需要的都算漂移）', () => {
  const entries = typedConfig as readonly {
    readonly languageOptions?: { readonly parserOptions?: { readonly project?: unknown } };
    readonly rules?: Readonly<Record<string, unknown>>;
  }[];
  const typedRules = entries.find(
    (e) => e.languageOptions?.parserOptions?.project !== undefined,
  )?.rules;
  assert.ok(typedRules !== undefined, '类型层没有 rules');
  assert.deepStrictEqual(
    Object.keys(typedRules).sort(),
    [...TYPED_ONLY_RULES].sort(),
    '类型层规则集与策略清单不一致（改清单请同时改 scripts/gateBudgetPolicy.mjs 并说明理由）',
  );
  for (const rule of TYPED_ONLY_RULES) {
    assert.strictEqual(typedRules[rule], 'error', `${rule} 必须以 error 级别启用`);
  }
});

test('⑥ 预算常量就是报告口径，且只有一份（gateBudget.mjs 引用策略模块）', () => {
  assert.strictEqual(FAST_BUDGET_SECONDS, 65, '快层预算被改动：报告口径是 eslint . < 65 s');
  assert.strictEqual(
    TYPED_BUDGET_SECONDS,
    45,
    '类型层预算被改动：报告口径是 tsc + typed eslint ≤ 45 s',
  );
  assert.strictEqual(TYPED_CONFIG_FILE, 'eslint.typed.config.mjs');
  const budgetSrc = read('scripts/gateBudget.mjs');
  assert.match(
    budgetSrc,
    /from '\.\/gateBudgetPolicy\.mjs'/,
    '预算脚本必须从策略模块取常量（两处各写一份 = 迟早漂移）',
  );
  const gatesSrc = read('scripts/runGates.mjs');
  assert.match(
    gatesSrc,
    /--tier=fast\|typed\|all|--tier=\$\{raw\}/,
    'runGates 必须支持 --tier 选择层（否则"分层"只活在文档里）',
  );
});

test('⑦ 基础 eslint 配置不含类型信息（快层之所以快的前提）', () => {
  const entries = baseConfig as readonly {
    readonly files?: readonly string[];
    readonly languageOptions?: { readonly parserOptions?: Readonly<Record<string, unknown>> };
  }[];
  for (const entry of entries) {
    const parserOptions = entry.languageOptions?.parserOptions;
    if (parserOptions === undefined) continue;
    assert.strictEqual(
      parserOptions['project'],
      undefined,
      `基础配置项（files=${String(entry.files?.join(','))}）引入了 project ⇒ 快层不再快`,
    );
    assert.strictEqual(
      parserOptions['projectService'],
      undefined,
      '基础配置项引入了 projectService ⇒ 快层不再快',
    );
  }
});

test('⑧ --only 点到的门禁必须真的会跑（跨层静默丢弃即红）', () => {
  // 实跑 `runGates.mjs`：历史缺陷是**零门禁 + 打印通过**（`--only=tsc`，exit 0）与
  // **静默丢一半**（`--only=iron-law,tsc` 只跑 iron-law）。两者都是"少跑几条还算通过"。
  const run = (arg: string): { readonly status: number | null; readonly out: string } => {
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'runGates.mjs'), arg], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  for (const arg of ['--only=tsc', '--only=iron-law,tsc']) {
    const r = run(arg);
    assert.notStrictEqual(r.status, 0, `${arg} 必须非零退出（跨层 id 不得被静默丢弃）`);
    assert.match(r.out, /--only/, `${arg} 未给出可读原因`);
  }
  // 正对照：合法 id 必须**真跑**并如实报出条数——否则"拒绝一切"也能骗过上面的断言。
  const ok = run('--only=node-engine');
  assert.strictEqual(ok.status, 0, `--only=node-engine 应通过：${ok.out}`);
  assert.match(ok.out, /实跑 1\//, '通过行必须如实报出实跑条数（历史缺陷下"通过"曾是零信息）');
});
