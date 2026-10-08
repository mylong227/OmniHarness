/**
 * 工作流**运行日志**判据（2026-10-08 增补能力的持久化底座）。
 *
 * ## 锁死的四件事（都是「崩了之后能不能信这份日志」级别的判据）
 *
 * ① **追加可读**：create → step.start/end → run.end 折叠出正确终态与产出；
 * ② **崩溃容忍有界**：**最后一行**写了一半（进程被杀）⇒ 容忍；**中间行**损坏 ⇒ 拒绝加载
 *    （静默跳过中间损坏会把「丢了一步」伪装成「那轮没跑过」）；
 * ③ **自校验**：首行内嵌规格与其 `specHash` 不一致（外部改过）⇒ 拒绝加载；
 * ④ **哈希口径**：对象键顺序不敏感、**数组顺序敏感**（步骤顺序影响同层 tie-break），
 *    且 id 安全（拒绝路径穿越）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowRunLog } from '../../src/autonomy/workflowRunLog.js';
import { WorkflowSpecError } from '../../src/autonomy/workflowSpecError.js';
import type { WorkflowDef } from '../../src/ports/autonomy/workflowDef.js';

/** 两步工作流（含名字）。 */
const DEF: WorkflowDef = {
  name: 'demo run',
  steps: [
    { id: 'A', prompt: 'a' },
    { id: 'B', prompt: 'b', dependsOn: ['A'] },
  ],
};

/**
 * 在临时工作区里跑一段用例。
 * @param run 用例体（收到临时目录）。
 * @returns 无返回值。
 */
function withWorkspace(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'workflow-runlog-'));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('WorkflowRunLog', () => {
  it('create + 逐步追加 ⇒ 可折叠出终态、产出、尝试次数与中断点', () => {
    withWorkspace((root) => {
      const log = new WorkflowRunLog(root);
      const header = log.create(DEF, 'wf-test-1', 2);
      assert.strictEqual(header.specHash, WorkflowRunLog.hashSpec(DEF));
      log.appendStepStart('wf-test-1', 'A', 1);
      log.appendStepEnd('wf-test-1', {
        id: 'A',
        status: 'done',
        attempt: 1,
        output: '产出甲',
        steps: 3,
        durationMs: 12,
      });
      log.appendStepStart('wf-test-1', 'B', 1);
      log.appendStepEnd('wf-test-1', {
        id: 'B',
        status: 'failed',
        attempt: 1,
        error: '注入失败',
        steps: 1,
        durationMs: 5,
      });
      log.appendRunEnd('wf-test-1', false);

      const replay = log.read('wf-test-1');
      assert.deepStrictEqual(replay.header.spec, DEF);
      assert.strictEqual(replay.header.maxConcurrency, 2);
      assert.strictEqual(replay.statuses.get('A'), 'done');
      assert.strictEqual(replay.statuses.get('B'), 'failed');
      assert.strictEqual(replay.outputs.get('A'), '产出甲');
      assert.strictEqual(replay.outputs.has('B'), false, '失败步骤不得留下产出');
      assert.strictEqual(replay.interrupted.size, 0);
      assert.strictEqual(replay.attempts.get('B'), 1);
      assert.strictEqual(replay.ended, true);
      assert.ok(log.pathOf('wf-test-1').endsWith('wf-test-1.jsonl'));
    });
  });

  it('崩溃语义：末行半截 ⇒ 容忍；中间行损坏 ⇒ 拒绝加载', () => {
    withWorkspace((root) => {
      const log = new WorkflowRunLog(root);
      log.create(DEF, 'wf-crash', 1);
      log.appendStepStart('wf-crash', 'A', 1);
      // 模拟「进程在写 end 行时被杀」：手工追加半截 JSON。
      appendFileSync(log.pathOf('wf-crash'), '{"t":"step.end","id":"A","stat', 'utf8');
      const replay = log.read('wf-crash');
      assert.strictEqual(replay.interrupted.has('A'), true, '有 start 无 end ⇒ 中断点');
      assert.strictEqual(replay.statuses.has('A'), false);

      // 中间行损坏（末行之前）必须拒绝：静默跳过会丢步。
      const broken = log.pathOf('wf-crash');
      const lines = [
        '{"t":"run.start","runId":"wf-crash","specHash":"x","maxConcurrency":1,"at":"t","spec":{"steps":[]}}',
        'not-json-at-all',
        '{"t":"run.end","ok":true,"at":"t"}',
      ];
      writeFileSync(broken, lines.join('\n') + '\n', 'utf8');
      assert.throws(() => log.read('wf-crash'), /第 2 行损坏/);
    });
  });

  it('自校验：首行内嵌规格被外部改动 ⇒ 拒绝加载', () => {
    withWorkspace((root) => {
      const log = new WorkflowRunLog(root);
      log.create(DEF, 'wf-tamper', 1);
      const path = log.pathOf('wf-tamper');
      // 直接改写文件：把 spec 换掉但保留原 specHash（模拟外部改动/半手写日志）。
      const original = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      writeFileSync(
        path,
        `${JSON.stringify({ ...original, spec: { steps: [{ id: 'A', prompt: '改了' }] } })}\n`,
        'utf8',
      );
      assert.throws(() => log.read('wf-tamper'), /自校验失败/);
    });
  });

  it('runId 安全：拒绝路径穿越与非法字符', () => {
    withWorkspace((root) => {
      const log = new WorkflowRunLog(root);
      assert.throws(() => log.pathOf('../escape'), WorkflowSpecError);
      assert.throws(() => log.pathOf('a b'), WorkflowSpecError);
      assert.throws(() => log.create(DEF, 'a/b', 1), WorkflowSpecError);
    });
  });

  it('找不到运行日志 ⇒ 明确报错（不返回空状态）', () => {
    withWorkspace((root) => {
      const log = new WorkflowRunLog(root);
      assert.throws(() => log.read('wf-none'), /找不到运行日志/);
    });
  });

  it('哈希口径：对象键顺序不敏感、数组顺序敏感', () => {
    const a: WorkflowDef = { steps: [{ id: 'A', prompt: 'a', dependsOn: ['B'] }] };
    const b: WorkflowDef = { steps: [{ prompt: 'a', id: 'A', dependsOn: ['B'] }] } as WorkflowDef;
    assert.strictEqual(WorkflowRunLog.hashSpec(a), WorkflowRunLog.hashSpec(b), '键顺序不影响哈希');

    const c: WorkflowDef = {
      steps: [
        { id: 'A', prompt: 'a' },
        { id: 'B', prompt: 'b' },
      ],
    };
    const d: WorkflowDef = {
      steps: [
        { id: 'B', prompt: 'b' },
        { id: 'A', prompt: 'a' },
      ],
    };
    assert.notStrictEqual(
      WorkflowRunLog.hashSpec(c),
      WorkflowRunLog.hashSpec(d),
      '步骤顺序影响哈希',
    );
  });

  it('同 runId 二次 create ⇒ 覆盖旧档（新运行不得继承旧状态）', () => {
    withWorkspace((root) => {
      const log = new WorkflowRunLog(root);
      log.create(DEF, 'wf-reuse', 1);
      log.appendStepStart('wf-reuse', 'A', 1);
      log.appendStepEnd('wf-reuse', {
        id: 'A',
        status: 'done',
        attempt: 1,
        output: '旧产出',
        steps: 1,
        durationMs: 1,
      });
      // 同一个 runId 再开一次（serve 的台账 id 会复用）：旧状态必须被清掉。
      log.create({ steps: [{ id: 'A', prompt: '新定义' }] }, 'wf-reuse', 1);
      const replay = log.read('wf-reuse');
      assert.deepStrictEqual(replay.header.spec, { steps: [{ id: 'A', prompt: '新定义' }] });
      assert.strictEqual(replay.statuses.has('A'), false, '不得继承上一次运行的终态');
      assert.strictEqual(replay.outputs.has('A'), false, '不得继承上一次运行的产出');
    });
  });

  it('目录不存在时不产生任何文件（零行为）', () => {
    withWorkspace((root) => {
      assert.strictEqual(existsSync(join(root, '.omniharness')), false);
      const log = new WorkflowRunLog(root);
      void log.pathOf('wf-idle');
      assert.strictEqual(existsSync(join(root, '.omniharness')), false, '仅取路径不得创建目录');
    });
  });
});
