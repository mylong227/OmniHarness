/**
 * T4.2 反漂移接线测试：SWE 能力评测的「补丁应用前 / 后」指纹快照真的进了 EditDriftDetector。
 *
 * 覆盖：
 *   ① 指纹快照 + 差异喂给检测器：单次编辑不告警、A→B→A 回退即报 oscillation；
 *   ② `runGoldControl`（goldPatch 应用路径）确实驱动了注入的检测器（recorded > 0）；
 *   ③ 检测器状态按工作区重置：两个独立工作区各自 A→B / B→A，不得被误判成跨工作区振荡；
 *   ④ `formatSweReport` 把告警写进报告（输出面）；
 *   ⑤ `runSweSuite` 的 `reasoningFor` 把路由档位透传进模型请求（T5.5 接线）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Swebench } from '../../src/eval/swebench.js';
import type { SweReport, SweTask } from '../../src/eval/swebench.js';
import { EditDriftDetector } from '../../src/eval/editDriftDetector.js';
import { ScriptedModel } from '../../src/eval/scriptedModel.js';
import type { ModelOutput, ModelPort, ModelRequest } from '../../src/ports/model/model.js';

/** 恒绿评测命令（跑本测试的 node 本体，免 PATH 依赖）。 */
const GREEN_EVAL = `"${process.execPath}" --version`;

/** 内容 A / 内容 B（用于构造 A→B→A 振荡序列）。 */
const CONTENT_A = 'const value = 1;\nmodule.exports = { value };\n';
const CONTENT_B = 'const value = 2;\nmodule.exports = { value };\n';

/** A→B 的统一 diff（PatchApplier 期望的形状）。 */
const PATCH_A_TO_B = `--- a/bug.js\n+++ b/bug.js\n@@ -1,2 +1,2 @@\n-const value = 1;\n+const value = 2;\n module.exports = { value };\n`;

/** B→A 的统一 diff（反向）。 */
const PATCH_B_TO_A = `--- a/bug.js\n+++ b/bug.js\n@@ -1,2 +1,2 @@\n-const value = 2;\n+const value = 1;\n module.exports = { value };\n`;

/** 捕获到的模型请求摘要。 */
interface CapturedCall {
  /** 该请求的推理强度。 */
  readonly effort: string | undefined;
  /** 该请求携带的工具数（>0 = Agent 任务回合；0 = 辅助调用）。 */
  readonly toolCount: number;
}

/** 捕获推理强度的模型装饰器。 */
class CapturingModel implements ModelPort {
  /** 端口标识。 */
  public readonly name = 'capturing';
  /** 观察到的每次请求摘要。 */
  public readonly calls: CapturedCall[] = [];
  /** 内层模型。 */
  private readonly inner: ModelPort;

  /**
   * @param inner 被装饰的模型端口
   */
  public constructor(inner: ModelPort) {
    this.inner = inner;
  }

  /**
   * 记录档位后转发。
   * @param request 模型请求
   * @returns 内层输出
   */
  public async generate(request: ModelRequest): Promise<ModelOutput> {
    this.calls.push({ effort: request.reasoningEffort, toolCount: request.tools.length });
    return this.inner.generate(request);
  }

  /**
   * 任务回合（带工具）请求的档位序列。
   * @returns 档位数组
   */
  public taskEfforts(): Array<string | undefined> {
    return this.calls.filter((c) => c.toolCount > 0).map((c) => c.effort);
  }
}

/**
 * 构造最小 SWE 任务。
 * @param id 任务 id
 * @param seed 种子文件内容
 * @param goldPatch 可选 goldPatch
 * @returns SWE 任务
 */
function sweTask(id: string, seed: string, goldPatch?: string): SweTask {
  return {
    id,
    prompt: '修复 bug.js',
    seedFiles: { 'bug.js': seed },
    evalCmd: GREEN_EVAL,
    ...(goldPatch !== undefined ? { goldPatch } : {}),
  };
}

test('T4.2 指纹快照 → 检测器：单次编辑不告警，A→B→A→B 回退即报 oscillation', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'omni-drift-'));
  try {
    const file = join(ws, 'bug.js');
    const detector = new EditDriftDetector({ windowSize: 20, maxEditsPerFile: 50 });
    writeFileSync(file, CONTENT_A, 'utf8');
    let before = await Swebench.snapshotFiles(ws);

    // 编辑 1：A → B（检测器只看到「变化后的内容」为一次编辑）。
    writeFileSync(file, CONTENT_B, 'utf8');
    let after = await Swebench.snapshotFiles(ws);
    assert.deepStrictEqual(Swebench.recordDrift(detector, before, after), [], '首次编辑不告警');

    // 编辑 2：B → A（两态之间尚无重现，仍不告警）。
    writeFileSync(file, CONTENT_A, 'utf8');
    before = after;
    after = await Swebench.snapshotFiles(ws);
    assert.deepStrictEqual(Swebench.recordDrift(detector, before, after), []);

    // 编辑 3：A → B（B 在两态前出现过 ⇒ 指纹回退循环）。
    writeFileSync(file, CONTENT_B, 'utf8');
    before = after;
    after = await Swebench.snapshotFiles(ws);
    const alarms = Swebench.recordDrift(detector, before, after);
    assert.strictEqual(alarms.length, 1);
    assert.strictEqual(alarms[0]!.kind, 'oscillation');
    assert.strictEqual(alarms[0]!.file, 'bug.js');

    // 未注入检测器时零行为变更
    assert.deepStrictEqual(Swebench.recordDrift(undefined, before, after), []);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('T4.2 补丁应用路径：runGoldControl 真的把「应用前/后」差异喂给了检测器', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'omni-drift-gold-'));
  try {
    const detector = new EditDriftDetector({ windowSize: 20, maxEditsPerFile: 50 });
    const result = await Swebench.runGoldControl(
      sweTask('gold-a-to-b', CONTENT_A, PATCH_A_TO_B),
      ws,
      {
        driftDetector: detector,
      },
    );
    assert.strictEqual(result.passed, true, 'goldPatch 应用后评测应通过');
    assert.strictEqual(detector.recorded, 1, '补丁改了 1 个文件 ⇒ 检测器收到 1 次编辑事件');
    assert.strictEqual(result.driftAlarms, undefined, '单次补丁不产生告警');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('T4.2 按工作区重置：两个独立工作区不得被误判为跨工作区振荡', async () => {
  const wsA = mkdtempSync(join(tmpdir(), 'omni-drift-ws-a-'));
  const wsB = mkdtempSync(join(tmpdir(), 'omni-drift-ws-b-'));
  try {
    const detector = new EditDriftDetector({ windowSize: 20, maxEditsPerFile: 50 });
    const first = await Swebench.runGoldControl(sweTask('ws-a', CONTENT_A, PATCH_A_TO_B), wsA, {
      driftDetector: detector,
    });
    // 第二个工作区：内容回到首次见过的 A（若沿用旧指纹历史会被误判为振荡）。
    const second = await Swebench.runGoldControl(sweTask('ws-b', CONTENT_B, PATCH_B_TO_A), wsB, {
      driftDetector: detector,
    });
    assert.strictEqual(first.driftAlarms, undefined);
    assert.strictEqual(second.driftAlarms, undefined, '跨工作区沿用指纹历史会产生假振荡');
    assert.strictEqual(detector.recorded, 1, '每个工作区只统计本工作区的编辑');
  } finally {
    rmSync(wsA, { recursive: true, force: true });
    rmSync(wsB, { recursive: true, force: true });
  }
});

test('T4.2 报告面：formatSweReport 把漂移告警写进输出', () => {
  const report: SweReport = {
    suite: 'probe',
    mode: 'scripted',
    passed: 0,
    failed: 1,
    total: 1,
    totalDurationMs: 1,
    results: [
      {
        id: 't1',
        passed: false,
        evalExitCode: 1,
        mode: 'scripted',
        steps: 1,
        reason: '未通过',
        driftAlarms: [
          { kind: 'thrash', file: 'bug.js', detail: '窗口 20 次编辑中 6 次落在同一文件' },
        ],
      },
    ],
  };
  const text = Swebench.formatSweReport(report);
  assert.match(text, /反漂移·thrash/);
  assert.match(text, /反漂移告警合计: 1/);
});

test('T5.5 套件接线：runSweSuite 的 reasoningFor 把档位透传进模型请求', async () => {
  const captured = new CapturingModel(new ScriptedModel([{ text: '已完成。' }]));
  const report = await Swebench.runSweSuite(
    'reasoning-probe',
    [sweTask('probe', CONTENT_A)],
    null,
    'scripted',
    {
      modelFor: () => captured,
      reasoningFor: () => 'low',
    },
  );
  assert.strictEqual(report.total, 1);
  assert.ok(captured.taskEfforts().length >= 1, '套件应至少请求模型一次');
  assert.ok(
    captured.taskEfforts().every((e) => e === 'low'),
    `每任务都应带上路由档位，实际: ${JSON.stringify(captured.taskEfforts())}`,
  );
});
