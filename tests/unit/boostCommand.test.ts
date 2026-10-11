/**
 * `boost` 子命令判据（2026-10-10）：把「探针归档与跨次比对」与「按改动挑门禁子集」纳入 harness 后，
 * 钉住它们**口径**层面的行为——退出码语义、默认跑集、比对分类、门禁挑选的保守性。
 *
 * 判据口径（钉住"什么必须成立"，不写实现步骤）：
 *  ① 退出码是数据不是布尔：`3`/`4` 归为**判据类结论**（不是失败），`2`/超时归为**仪器失败**；
 *  ② 默认跑集只认登记过且不需网络的探针——新探针不能因"存在"就悄悄抬高每轮成本；
 *  ③ 比对必须把"数字变了"与"口径变了"分成不同 kind（把换口径当成回归/增益是本仓最贵的事故）；
 *  ④ 门禁挑选必须**保守**：纯文档改动不跑 eslint/tsc；未知文件类型；上游新增门禁 ⇒ 一律转全量。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoostProbes, PROBES_DIR, type BoostProbeRun } from '../../src/cli/boostProbes.js';
import { BoostCommand } from '../../src/cli/boostCommand.js';
import { BoostGateSurface, GATE_SURFACE } from '../../src/cli/boostGateSurface.js';

/**
 * 造一个临时仓库根（用完即删）。
 * @param fn 使用该根的测试体。
 * @returns 无返回值。
 */
function withTempRoot(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'omni-boost-'));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** 造一份最小探针归档。 */
function run(probes: BoostProbeRun['probes']): BoostProbeRun {
  const ok = probes.filter((p) => p.outcome === 'ok').length;
  return {
    dir: '.omniharness/boost/20261010-000000',
    probes,
    ok,
    instrument: probes.filter((p) => p.outcome === 'instrument').length,
    measurement: probes.filter((p) => p.outcome === 'measurement').length,
    exitCode: 0,
  };
}

/** 造一条探针记录。 */
function record(
  probe: string,
  scalars: Record<string, number | boolean>,
): BoostProbeRun['probes'][number] {
  return {
    probe,
    status: 0,
    outcome: 'ok',
    timedOut: false,
    durationMs: 1,
    reportPath: `x/${probe}.json`,
    stdoutPath: `x/${probe}.out.txt`,
    stderrPath: `x/${probe}.err.txt`,
    scalars,
  };
}

test('① 退出码语义：3/4 是结论、2 与超时是仪器失败、0 是通过', () => {
  assert.strictEqual(BoostProbes.classifyExit(0, false), 'ok');
  assert.strictEqual(BoostProbes.classifyExit(3, false), 'measurement');
  assert.strictEqual(BoostProbes.classifyExit(4, false), 'measurement');
  assert.strictEqual(BoostProbes.classifyExit(2, false), 'instrument');
  assert.strictEqual(BoostProbes.classifyExit(1, false), 'instrument');
  assert.strictEqual(BoostProbes.classifyExit(null, true), 'instrument');
  // 元数据可**收窄**结论码（`semanticCrossRepo` 的 2 是"外部语料缺失"，不是"判据无区分力"）。
  assert.strictEqual(
    BoostProbes.classifyExit(2, false, { measurementExitCodes: [3] }),
    'instrument',
  );
  assert.strictEqual(
    BoostProbes.classifyExit(3, false, { measurementExitCodes: [3] }),
    'measurement',
  );
});

test('② 默认跑集：需网络的不进、未登记的不进、显式开关后网络探针才进', () => {
  const all = ['recallHitrate', 'semanticHybridRecall', 'brandNewProbe'];
  assert.deepStrictEqual(BoostProbes.defaultSelection(all, false), ['recallHitrate']);
  assert.deepStrictEqual(BoostProbes.defaultSelection(all, true), [
    'recallHitrate',
    'semanticHybridRecall',
  ]);
});

test('② 探针发现：只认 tools/probes/*.mjs，`_` 前缀共享模块不算探针', () => {
  withTempRoot((root) => {
    const dir = join(root, PROBES_DIR);
    mkdirSync(dir, { recursive: true });
    for (const name of ['a.mjs', '_shared.mjs', 'b.mjs', 'README.md']) {
      writeFileSync(join(dir, name), '', 'utf8');
    }
    assert.deepStrictEqual(BoostProbes.discover(root), ['a', 'b']);
  });
  // 目录不存在 ⇒ 空数组（调用方负责 fail-closed），不抛。
  withTempRoot((root) => {
    assert.deepStrictEqual(BoostProbes.discover(root), []);
  });
});

test('② 默认入参：rerank 的位置参数必须显式给，避免"同名两个数字不可比"', () => {
  assert.deepStrictEqual(BoostProbes.argsFor('rerankDiscriminatorAb', 'out.json', []), [
    '14',
    '--json=out.json',
  ]);
  assert.deepStrictEqual(BoostProbes.argsFor('recallHitrate', 'out.json', []), ['--json=out.json']);
  // 显式入参覆盖默认
  assert.deepStrictEqual(BoostProbes.argsFor('recallHitrate', 'o.json', ['--fileK=14']), [
    '--fileK=14',
    '--json=o.json',
  ]);
});

test('③ 标量提取：数字与布尔进，字符串、数组、null 不进', () => {
  const out: Record<string, number | boolean> = {};
  BoostProbes.collectScalars(
    {
      n: 1,
      ok: true,
      s: 'text',
      arr: [1, 2, 3],
      nested: { deep: 2.5, skip: 'x' },
      nil: null,
    },
    '',
    out,
  );
  assert.deepStrictEqual(out, { n: 1, ok: true, 'nested.deep': 2.5 });
});

test('③ 比对：数字变化给 Δ，键增删是"口径变了"，分类变化单列，探针增删单列', () => {
  const baseline = run([record('p', { hitRate: 0.4, rerank: false, gone: 1 })]);
  const current = run([
    {
      ...record('p', { hitRate: 0.5, rerank: false, fresh: 7 }),
      outcome: 'measurement',
    },
    record('newcomer', { x: 1 }),
  ]);
  const entries = BoostProbes.diff(current, baseline);
  const kinds = entries.map((e) => `${e.kind}:${e.probe}:${e.key ?? '-'}`);
  assert.ok(kinds.includes('change:p:hitRate'), `期望有 change:hitRate，实得 ${kinds.join(', ')}`);
  assert.ok(kinds.includes('add:p:fresh'));
  assert.ok(kinds.includes('remove:p:gone'));
  assert.ok(kinds.includes('class:p:-'), '分类变化必须单列（读数前提变了）');
  assert.ok(kinds.includes('probe:newcomer:-'));
  const delta = entries.find((e) => e.kind === 'change');
  assert.match(delta?.note ?? '', /Δ=0\.100000/);
  // 未变的布尔不产生条目
  assert.strictEqual(entries.filter((e) => e.key === 'rerank').length, 0);
});

test('③ 比对：本轮未跑的探针要报"未跑"，不能表现为"读数没变"', () => {
  const baseline = run([record('a', { v: 1 }), record('b', { v: 1 })]);
  const current = run([record('a', { v: 1 })]);
  const entries = BoostProbes.diff(current, baseline);
  assert.deepStrictEqual(
    entries.map((e) => `${e.kind}:${e.probe}`),
    ['probe:b'],
  );
  assert.match(entries[0]?.note ?? '', /未跑/);
});

/** 造门禁清单（形状与 `runGates.mjs --list` 一致：id / tier / label）。 */
function gates(
  list: readonly [string, string][],
): readonly { id: string; tier: string; label: string }[] {
  return list.map(([id, tier]) => ({ id, tier, label: `${id} label` }));
}

/** `runGates.mjs --list` 的当前形状（本仓 12 条：fast 10 + typed 2）。 */
const REAL_GATES = gates([
  ['node-engine', 'fast'],
  ['iron-law', 'fast'],
  ['maturity', 'fast'],
  ['standard-delta', 'fast'],
  ['arch', 'fast'],
  ['wiring', 'fast'],
  ['doc-links', 'fast'],
  ['secrets', 'fast'],
  ['top-level-fn', 'fast'],
  ['eslint', 'fast'],
  ['tsc', 'typed'],
  ['eslint-typed', 'typed'],
]);

test('④ 纯文档改动：只跑密钥面与死链面，不跑 eslint/tsc（判定由取证过的表面声明驱动）', () => {
  const d = BoostCommand.decide(REAL_GATES, ['docs/guide.md', 'README.md'], 'fast');
  assert.strictEqual(d.fallback, null);
  assert.deepStrictEqual([...d.selected].sort(), ['doc-links', 'secrets']);
  assert.ok(!d.selected.includes('eslint'), '文档不在 eslint 的判定面内');
  assert.ok(!d.selected.includes('iron-law'), '文档不在 iron-law 的判定面内');
  assert.strictEqual(d.inTier, 10);
  assert.strictEqual(d.allGates, 12);
  assert.match(d.reasons['eslint'] ?? '', /不在其判定面内/);
});

test('④ 源码改动：命中 eslint/tsc/top-level-fn/wiring/arch/iron-law/maturity', () => {
  const d = BoostCommand.decide(REAL_GATES, ['src/core/agent.ts'], 'all');
  for (const id of [
    'eslint',
    'tsc',
    'eslint-typed',
    'top-level-fn',
    'wiring',
    'arch',
    'iron-law',
    'maturity',
    'standard-delta',
    'secrets',
  ]) {
    assert.ok(d.selected.includes(id), `源码改动应跑 ${id}`);
  }
  assert.strictEqual(d.fallback, null);
});

test('④ 未知文件类型：只有全路径面（secrets）命中，其余不跑——不靠"猜"', () => {
  const d = BoostCommand.decide(REAL_GATES, ['weird.unknownext'], 'fast');
  // secrets 的输入面是 `**`（实测零 fs 读取、全经 git 子进程）⇒ 它必然命中；
  // 其它门禁都有**取证过的**窄表面，故本次改动确实与它们无关。
  assert.deepStrictEqual(d.selected, ['secrets']);
  assert.strictEqual(d.fallback, null);
});

test('④ 改判据自身的输入面（门禁脚本/依赖白名单/配置）⇒ 命中相应门禁', () => {
  // `scripts/checkFuncBaseline.json` 是 iron-law 的取证输入面之一 ⇒ 必须跑 iron-law。
  const iron = BoostCommand.decide(REAL_GATES, ['scripts/checkFuncBaseline.json'], 'fast');
  assert.ok(iron.selected.includes('iron-law'));
  // 配置面不在任何窄表面内 ⇒ 只有 secrets（全路径面）。
  const cfg = BoostCommand.decide(REAL_GATES, ['omniharness.json'], 'fast');
  assert.deepStrictEqual(cfg.selected, ['secrets']);
});

test('④ 上游新增门禁（表面表里没有它）⇒ 转全量并点名是哪一条', () => {
  const withNewGate = gates([
    ...REAL_GATES.map((g) => [g.id, g.tier] as [string, string]),
    ['brand-new-gate', 'fast'],
  ]);
  const d = BoostCommand.decide(withNewGate, ['docs/guide.md'], 'fast');
  assert.notStrictEqual(d.fallback, null);
  assert.match(d.fallback ?? '', /brand-new-gate/);
  assert.ok(d.unmatched.includes('brand-new-gate'));
  assert.strictEqual(d.selected.length, 11, '转全量 ⇒ 该层全部（含新门禁）');
});

test('④ 表面表必须覆盖上游**当前**全部门禁（漏一条即红，逼出补声明）', () => {
  const live = new BoostCommand(process.cwd()).readGates();
  assert.ok(live.length > 0, '读不出上游门禁清单，判据无法成立');
  const missing = live.filter((g) => GATE_SURFACE[g.id] === undefined).map((g) => g.id);
  assert.deepStrictEqual(
    missing,
    [],
    `上游有门禁未登记进 boostGateSurface.ts：${missing.join(', ')}。` +
      '这不是崩溃，而是"它永远跑"——请取证后补声明，别让它长期停在兜底态。',
  );
});

test('④ 表面表里不得有指向已消失门禁的僵尸条目', () => {
  const live = new BoostCommand(process.cwd()).readGates();
  const ids = new Set(live.map((g) => g.id));
  const zombie = Object.keys(GATE_SURFACE).filter((id) => !ids.has(id));
  assert.deepStrictEqual(
    zombie,
    [],
    `boostGateSurface.ts 里有上游已不存在的门禁：${zombie.join(', ')}`,
  );
});

test('④ glob 匹配语义：`**/` 吞零层目录、`*` 不跨 `/`、`?` 单字符', () => {
  assert.ok(BoostGateSurface.matches('src/**/*.ts', 'src/a.ts'), '**/ 必须能匹配零层目录');
  assert.ok(BoostGateSurface.matches('src/**/*.ts', 'src/x/y/a.ts'));
  assert.ok(!BoostGateSurface.matches('src/*.ts', 'src/x/a.ts'), '* 不得跨 /');
  assert.ok(BoostGateSurface.matches('src/*.ts', 'src/a.ts'));
  assert.ok(BoostGateSurface.matches('**', 'anything/at/all.txt'), '全路径面必须匹配任意路径');
  assert.ok(BoostGateSurface.matches('docs/**', 'docs/adr/0001.md'));
  assert.ok(!BoostGateSurface.matches('docs/**', 'src/a.ts'));
});

test('④ 未取证的门禁永不跳过（fail-closed 闸门）+ 声明字段完整性', () => {
  assert.strictEqual(
    BoostGateSurface.skippabilityOf('a-gate-that-does-not-exist').skippable,
    false,
  );
  for (const [id, decl] of Object.entries(GATE_SURFACE)) {
    assert.notStrictEqual(decl.audited, '', `${id} 的声明必须有实测取证结论（否则它永不跳过）`);
    assert.ok((decl.inputs?.length ?? 0) > 0, `${id} 必须声明判定输入`);
    assert.ok(decl.why.length > 0, `${id} 必须说明"为什么是这些路径"`);
  }
  assert.strictEqual(BoostGateSurface.skippabilityOf('eslint').skippable, true);
});

test('④ 无改动：选中 0 条 ⇒ 转该层全量，绝不伪装成"没改动所以不用跑"', () => {
  const d = BoostCommand.decide(REAL_GATES, [], 'fast');
  // 注意：`secrets` 的输入面是"本次提交的全部内容"——没有改动时它**也不命中**，
  // 于是该层选中 0 条。此处必须转全量：否则"没有改动"会变成"跳过一切"，
  // 而这恰恰是最危险的静默形态（历史缺陷：零门禁 + 打印通过）。
  assert.match(d.fallback ?? '', /选中 0 条/);
  assert.strictEqual(d.selected.length, 10);
  assert.match(d.reasons['eslint'] ?? '', /全量：分类被放弃/);
});
