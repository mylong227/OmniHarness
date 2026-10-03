/**
 * **记忆 primer 机制判据**（G9-c/M1，2026-10-03 第二十二轮）。
 *
 * ## 它锁的是什么
 *
 * 报告 M1 要求"记忆增益判据：**先能判死、再谈投入**"。离线无 key 时，任务级的 primer on/off A/B
 * 只会**测到自己的脚本模型**（假数字）⇒ 本判据量的是**机制**（回灌内容本身），并**实跑探针**把
 * 结论变成可执行断言：
 *
 * | # | 判据 |
 * | --- | --- |
 * | ① | 探针可跑通并输出结构完整的 JSON（`probe` / `off` / `on` / `randomControl` / `controlDiscriminates`） |
 * | ② | **primer 关 ⇒ 覆盖率 0**（构造性事实：不注入就没有回灌内容） |
 * | ③ | **primer 开 ⇒ 相关性 ≥ 0.8**（查询所问的那条事实进入 5 个名额；本机实测 100%） |
 * | ④ | **两关都过**：配对 bootstrap CI 不跨 0 **且** 留出折无负（报告 M1 的原话口径） |
 * | ⑤ | **判死能力自证**：随机注入对照必须**显著更差**——否则判据没有区分力，探针以退出码 3 提示 |
 * | ⑥ | 代价被如实报出（回灌 token），且**口径声明**里写明"这不是 LLM 任务增益" |
 *
 * 判据⑤是本判据的灵魂：只会说好话的判据没有价值。本仓已有一条被自己证伪的路径正是"查询不敏感"
 * （每次给不同的文件、但不给对的文件）——随机对照就是在复现那种失败形态。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const PROBE = join(ROOT, 'tools', 'probes', 'memoryLiftProbe.mjs');
const OUT = join(ROOT, '.omni-storage', 'memoryLiftProbeSelfCheck.json');

/** 探针报告形状（只声明判据用得到的字段）。 */
interface ProbeReport {
  readonly probe: string;
  readonly caliber: string;
  readonly budget: number;
  readonly off: { readonly coverage: number; readonly hitRate: number };
  readonly on: {
    readonly coverage: number;
    readonly hitRate: number;
    readonly injectedTokens: number;
    readonly ci95: readonly [number, number];
    readonly folds: { readonly neg: number; readonly total: number };
  };
  readonly randomControl: {
    readonly hitRate: number;
    readonly coverage: number;
    readonly ci95: readonly [number, number];
  };
  readonly controlDiscriminates: boolean;
}

/** 跑一次探针（退出码 0 = 判死能力自证通过）并读回 JSON。 */
function runProbe(): ProbeReport {
  execFileSync(process.execPath, [PROBE, `--json=${OUT}`], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(readFileSync(OUT, 'utf8')) as ProbeReport;
}

let report: ProbeReport | undefined;

test('① 探针可跑通并输出结构完整的报告', () => {
  try {
    report = runProbe();
  } finally {
    rmSync(OUT, { force: true });
  }
  assert.ok(report !== undefined, '探针未产出报告');
  assert.strictEqual(report.probe, 'memoryLiftProbe');
  assert.ok(report.budget >= 3, `primer 名额异常：${String(report.budget)}`);
});

test('② primer 关 ⇒ 覆盖率 0（不注入就没有回灌内容）', () => {
  assert.ok(report !== undefined, '前置探针未跑通');
  assert.strictEqual(report.off.coverage, 0, 'primer 关时不该有任何回灌');
  assert.strictEqual(report.off.hitRate, 0);
});

test('③ primer 开 ⇒ 相关性 ≥ 0.8（查询所问的事实进入名额）', () => {
  assert.ok(report !== undefined, '前置探针未跑通');
  assert.ok(report.on.coverage > 0, 'primer 开时应有回灌');
  assert.ok(
    report.on.hitRate >= 0.8,
    `相关性过低（${String(report.on.hitRate)}）：回灌内容与查询无关，primer 只是噪声`,
  );
});

test('④ 两关都过：CI 不跨 0 且留出折无负（报告 M1 的原话口径）', () => {
  assert.ok(report !== undefined, '前置探针未跑通');
  const [lo, hi] = report.on.ci95;
  assert.ok(lo > 0 && hi > 0, `primer 开的配对 CI 跨 0 或非正：${JSON.stringify(report.on.ci95)}`);
  assert.strictEqual(
    report.on.folds.neg,
    0,
    `留出折出现负值 ${String(report.on.folds.neg)}/${String(report.on.folds.total)} ⇒ 不满足"折同向"`,
  );
});

test('⑤ 判死能力自证：随机注入对照显著更差（否则判据不可信）', () => {
  assert.ok(report !== undefined, '前置探针未跑通');
  assert.strictEqual(
    report.controlDiscriminates,
    true,
    '随机对照与召回几乎一样 ⇒ 这套判据没有区分力（正是本仓已证伪的"查询不敏感"失败形态）',
  );
  // **对照必须非退化**：它要"注入错的事实"，而不是"什么都不注入"。
  //（2026-10-03 实测：把对照改成空注入后，旧判据照样绿——因为 0% < 100% 仍然成立。）
  assert.ok(
    report.randomControl.coverage > 0,
    '随机对照一条都没注入 ⇒ 这是退化对照（空 vs 有），证明不了判据有区分力',
  );
  assert.ok(report.randomControl.hitRate < report.on.hitRate, '随机对照的相关性不应不低于召回');
  assert.ok(
    report.randomControl.ci95[0] > 0,
    '随机对照与召回的差必须显著（CI 不跨 0），否则只是噪声',
  );
});

test('⑥ 代价被如实报出，且口径声明写明"不是 LLM 任务增益"', () => {
  assert.ok(report !== undefined, '前置探针未跑通');
  assert.ok(report.on.injectedTokens > 0, '回灌代价应 > 0（primer 开）');
  assert.match(
    report.caliber,
    /不是.*LLM.*增益|机制级/,
    '报告必须自带口径声明：这是机制级判据，不能读成 LLM 任务增益',
  );
});
