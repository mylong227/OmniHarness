/**
 * T4.6 / T5.5 接线测试：隔离评测（评测只吃冻结快照）+ 推理强度路由（难度分层 → 模型请求）。
 *
 * 断言的是「接线真的生效」，不是「模块存在」：
 *   ① `runTaskIsolated` 的评测命令跑在**快照副本**上——非隔离路径会在活工作区留下副作用，隔离路径不会；
 *   ② 同一产物在两条路径下结论一致（隔离不改变判据，只切断活引用）；
 *   ③ `ReasoningRouter.route()` 的档位真的出现在模型请求的 `reasoningEffort` 上（易→low / 难→high）；
 *   ④ 不注入档位时不发该字段（零行为变更）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runTask, runTaskIsolated } from '../../src/eval/evalHarness.js';
import type { EvalTask } from '../../src/eval/evalHarness.js';
import { ScriptedModel } from '../../src/eval/scriptedModel.js';
import type { ScriptStep } from '../../src/eval/scriptedModel.js';
import { ReasoningRouter } from '../../src/eval/reasoningRouter.js';
import type { ModelOutput, ModelPort, ModelRequest } from '../../src/ports/model/model.js';

/** 捕获到的模型请求摘要。 */
interface CapturedCall {
  /** 该请求的推理强度。 */
  readonly effort: string | undefined;
  /** 该请求携带的工具数（>0 = Agent 任务回合；0 = 辅助调用，如长期记忆抽取）。 */
  readonly toolCount: number;
}

/** 捕获每次模型请求的推理强度（装饰器：透传给内层模型）。 */
class CapturingModel implements ModelPort {
  /** 端口标识。 */
  public readonly name = 'capturing';
  /** 每次 generate 观察到的请求摘要（按调用顺序）。 */
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
   * 记录请求的推理强度后转发给内层模型。
   * @param request 模型请求
   * @returns 内层模型的输出
   */
  public async generate(request: ModelRequest): Promise<ModelOutput> {
    this.calls.push({ effort: request.reasoningEffort, toolCount: request.tools.length });
    return this.inner.generate(request);
  }

  /**
   * 任务回合（带工具）请求的推理强度序列——辅助调用（长期记忆抽取等）不计入。
   * @returns 按调用顺序的档位数组
   */
  public taskEfforts(): Array<string | undefined> {
    return this.calls.filter((c) => c.toolCount > 0).map((c) => c.effort);
  }
}

/** 写文件的模型脚本（两步：工具回合 + 终态）。 */
function writeOutScript(): readonly ScriptStep[] {
  return [
    {
      toolCalls: [{ id: 'c1', name: 'write_file', arguments: { path: 'out.txt', content: 'ok' } }],
    },
    { text: '已写出 out.txt。' },
  ];
}

/**
 * 构造「写 out.txt」任务。
 * @param prompt 任务 prompt（决定难度分层）
 * @param runCmd 可选：评测阶段要执行的命令
 * @returns 评估任务
 */
function writeOutTask(prompt: string, runCmd?: string): EvalTask {
  return {
    id: 'write-out',
    prompt,
    script: writeOutScript(),
    expect: {
      files: { 'out.txt': 'ok' },
      ...(runCmd !== undefined ? { run: { cmd: runCmd } } : {}),
    },
  };
}

test('T5.5 路由接线：易任务的档位（low）真的进了模型请求', async () => {
  const router = new ReasoningRouter();
  const prompt = '把 out.txt 写成 ok';
  const effort = router.route(prompt);
  assert.strictEqual(effort, 'low', '短任务难度分 ≤1 ⇒ low');

  const ws = mkdtempSync(join(tmpdir(), 'omni-route-low-'));
  try {
    const model = new CapturingModel(new ScriptedModel(writeOutScript()));
    const result = await runTaskIsolated(writeOutTask(prompt), ws, model, {
      reasoningEffort: effort,
    });
    assert.strictEqual(result.passed, true);
    const efforts = model.taskEfforts();
    assert.ok(efforts.length >= 2, '工具回合 + 终态 ⇒ 至少两次任务请求');
    assert.ok(
      efforts.every((e) => e === 'low'),
      `路由档位必须逐请求透传，实际: ${JSON.stringify(efforts)}`,
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('T5.5 路由接线：难任务的档位（high）真的进了模型请求', async () => {
  const router = new ReasoningRouter();
  const prompt =
    'x'.repeat(501) +
    '\n```ts\nconst a = 1;\n```\n先读文件再改代码，第一步必须保留接口，至少覆盖 2 个用例，不得超过 10 行。';
  const effort = router.route(prompt);
  assert.strictEqual(effort, 'high', '长文 + 代码块 + 多步 + 约束 ⇒ high');

  const ws = mkdtempSync(join(tmpdir(), 'omni-route-high-'));
  try {
    const model = new CapturingModel(new ScriptedModel(writeOutScript()));
    const result = await runTaskIsolated(writeOutTask(prompt), ws, model, {
      reasoningEffort: effort,
    });
    assert.strictEqual(result.passed, true);
    assert.ok(model.taskEfforts().every((e) => e === 'high'));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('T5.5 缺省零行为变更：不注入档位 → 请求不带 reasoningEffort', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'omni-route-none-'));
  try {
    const model = new CapturingModel(new ScriptedModel(writeOutScript()));
    const result = await runTaskIsolated(writeOutTask('写 out.txt'), ws, model);
    assert.strictEqual(result.passed, true);
    assert.ok(model.calls.length >= 1);
    assert.ok(model.calls.every((c) => c.effort === undefined));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('T4.6 隔离接线：评测命令只在快照副本上执行，生成方工作区不留评测副作用', async () => {
  const marker = 'eval-marker.txt';
  const cmd = `"${process.execPath}" -e "require('fs').writeFileSync('${marker}','from-eval')"`;
  const task = writeOutTask('写 out.txt 并自检', cmd);

  const liveWs = mkdtempSync(join(tmpdir(), 'omni-iso-live-'));
  const isoWs = mkdtempSync(join(tmpdir(), 'omni-iso-snap-'));
  try {
    // 非隔离路径：断言命令在活工作区执行 → 留下 marker。
    const live = await runTask(task, liveWs);
    assert.strictEqual(live.passed, true);
    assert.strictEqual(
      existsSync(join(liveWs, marker)),
      true,
      '非隔离路径的评测命令在活工作区执行（对照）',
    );

    // 隔离路径：同一任务、同一产物，但断言只在冻结快照的 scratch 副本上跑 → 活工作区无 marker。
    const iso = await runTaskIsolated(task, isoWs);
    assert.strictEqual(iso.passed, true, '隔离不得改变判据（同产物同结论）');
    assert.strictEqual(
      existsSync(join(isoWs, marker)),
      false,
      '评测副作用不得落在生成方工作区（证明评测只吃快照）',
    );
    assert.strictEqual(existsSync(join(isoWs, 'out.txt')), true, '生成产物仍在生成方工作区');
    assert.strictEqual(iso.isolation?.frozen, true, '评测输入必须是冻结快照');
    assert.ok((iso.isolation?.snapshotFiles ?? 0) >= 1, '快照应含 out.txt 产物文件');
    assert.strictEqual(iso.isolation?.verdict, 1);
  } finally {
    rmSync(liveWs, { recursive: true, force: true });
    rmSync(isoWs, { recursive: true, force: true });
  }
});
