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

test('④ 纯文档改动：只跑兜底集 + doc-links，绝不跑 eslint/tsc', () => {
  const d = BoostCommand.decide(REAL_GATES, ['docs/guide.md', 'README.md'], 'fast');
  assert.strictEqual(d.fallback, null);
  assert.ok(d.selected.includes('doc-links'));
  assert.ok(d.selected.includes('iron-law'), '兜底集必须常驻');
  assert.ok(!d.selected.includes('eslint'), '文档改动不该跑 eslint');
  assert.ok(!d.selected.includes('tsc'), 'fast 层本就不含 tsc');
  assert.strictEqual(d.selected.length, 6);
  assert.strictEqual(d.inTier, 10);
  assert.strictEqual(d.allGates, 12);
});

test('④ 源码改动：带上 eslint/tsc/top-level-fn/wiring 等判定面', () => {
  const d = BoostCommand.decide(REAL_GATES, ['src/core/agent.ts'], 'all');
  for (const id of ['eslint', 'tsc', 'eslint-typed', 'top-level-fn', 'wiring']) {
    assert.ok(d.selected.includes(id), `源码改动应跑 ${id}`);
  }
  assert.strictEqual(d.fallback, null);
});

test('④ 未知文件类型 ⇒ 转全量（不猜）', () => {
  const d = BoostCommand.decide(REAL_GATES, ['weird.unknownext'], 'fast');
  assert.notStrictEqual(d.fallback, null);
  assert.deepStrictEqual(d.unmatched, ['weird.unknownext']);
  assert.strictEqual(d.selected.length, 10, '转全量 ⇒ 该层全部');
});

test('④ 改判据自身（门禁脚本/探针/配置面）⇒ 转全量', () => {
  for (const path of [
    'scripts/runGates.mjs',
    'tools/probes/recallHitrate.mjs',
    'tests/unit/x.test.ts',
    'package.json',
    'tsconfig.json',
    '.gitignore',
  ]) {
    const d = BoostCommand.decide(REAL_GATES, [path], 'fast');
    assert.notStrictEqual(d.fallback, null, `${path} 应触发全量`);
    assert.strictEqual(d.selected.length, 10);
  }
});

test('④ 上游新增门禁（本表不可达）⇒ 转全量并点名是哪一条', () => {
  const withNewGate = gates([
    ...REAL_GATES.map((g) => [g.id, g.tier] as [string, string]),
    ['brand-new-gate', 'fast'],
  ]);
  const d = BoostCommand.decide(withNewGate, ['docs/guide.md'], 'fast');
  assert.notStrictEqual(d.fallback, null);
  assert.match(d.fallback ?? '', /brand-new-gate/);
});

test('④ 该层选空 ⇒ 转该层全量，绝不打印成"通过"', () => {
  // typed 层与纯文档改动无交集 ⇒ 必须转 typed 全量，而不是"跑了 0 条也算过"。
  const d = BoostCommand.decide(REAL_GATES, ['docs/guide.md'], 'typed');
  assert.strictEqual(d.selected.length, 2);
  assert.match(d.fallback ?? '', /选中 0 条/);
});

test('④ 无改动：只跑兜底集，且不声称覆盖了别的判定面', () => {
  const d = BoostCommand.decide(REAL_GATES, [], 'fast');
  assert.strictEqual(d.fallback, null);
  assert.deepStrictEqual(d.selected, [
    'node-engine',
    'iron-law',
    'maturity',
    'standard-delta',
    'arch',
  ]);
  assert.match(d.reasons['eslint'] ?? '', /不在该门禁的判定面上/);
  assert.match(d.reasons['tsc'] ?? '', /不在本次层/);
});
