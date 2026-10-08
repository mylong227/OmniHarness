/**
 * 工作流**受控条件执行**与**断点续跑**的运行期判据（2026-10-08 增补能力）。
 *
 * ## 这四组判据各自钉死一条商业级语义
 *
 * ① **条件成立才执行**：`when` 命中 ⇒ 执行；不命中 ⇒ `skipped`（**设计内跳过**）；
 * ② **补救模式真的能用**：上游 `failed` 时，声明 `when:{step,status:'failed'}` 的补救步必须**照跑**
 *    ——若把「先失败传播、后条件裁决」写反，补救步会被上游拖成 blocked，功能静默失效；
 * ③ **跳过不阻断、故障必阻断**：`skipped` 下游照跑且整体可判成功；`blocked` 下游被 fail-closed 拖死；
 * ④ **续跑只复用真的完成了的**：`done` 步复用产出（记入 `resumed`），失败/中断步骤重跑并留下 attempt 留痕；
 *    规格不一致时**拒绝续跑**（绝不把两份定义的产出拼在一起）；未开启持久化时**零写盘**。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventPort } from '../../src/ports/runtime/eventPort.js';
import type { ModelOutput, ModelPort, ModelRequest } from '../../src/ports/model/model.js';
import type { LongTermMemoryPort, MemoryFact } from '../../src/ports/memory/longTermMemory.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import { DenyEscalation } from '../../src/adapters/escalation/denyEscalation.js';
import { MemorySpill } from '../../src/adapters/spill/memorySpill.js';
import { RegistryToolPort } from '../../src/adapters/tool/registryToolPort.js';
import { ToolResultSpiller } from '../../src/context/toolResultSpiller.js';
import { WorkflowRunner } from '../../src/autonomy/workflowRunner.js';
import { WorkflowRunLog } from '../../src/autonomy/workflowRunLog.js';
import { WorkflowSpecError } from '../../src/autonomy/workflowSpecError.js';
import type { WorkflowDef } from '../../src/ports/autonomy/workflowDef.js';
import type { SubagentPortsShape } from '../../src/subagent/subagentPorts.js';

/** 可控失败模型：prompt 命中 `failOn` 即抛错；`failOn` 可在两次运行之间改写。 */
class SwitchableModel implements ModelPort {
  /** 端口名（适配器契约要求）。 */
  public readonly name = 'switchable';

  /** 当前会导致失败的标记（undefined = 永不失败）。 */
  public failOn: string | undefined;

  /** 每次模型的「可见 prompt」记录（用于验证依赖注入与重跑事实）。 */
  public readonly prompts: string[] = [];

  /**
   * @param failOn 初始失败标记（undefined = 永不失败）。
   */
  public constructor(failOn?: string) {
    this.failOn = failOn;
  }

  /**
   * @param request 模型请求（只关心最后一条 user 消息）。
   * @returns 回显文本；命中失败标记时抛错。
   */
  public async generate(request: ModelRequest): Promise<ModelOutput> {
    const lastUser = [...request.messages].reverse().find((message) => message.role === 'user');
    const text = lastUser?.content ?? '';
    this.prompts.push(text);
    if (this.failOn !== undefined && text.includes(this.failOn)) {
      throw new Error('步骤执行失败（测试注入）');
    }
    // 回显最后一段（依赖注入的上下文在 prompt 尾部），便于断言下游确实看到了上游产出。
    return { text };
  }
}

/** 收集型事件端口。 */
class RecordingEvents implements EventPort {
  /** 端口名（适配器契约要求）。 */
  public readonly name = 'recording';

  /**
   * @param event 忽略的事件（本桩只用于满足端口契约）。
   * @returns 无返回值。
   */
  public emit(event: never): void {
    void event;
  }
}

/** 内存版长期记忆桩。 */
function makeLongTermStub(): LongTermMemoryPort {
  const facts: MemoryFact[] = [];
  return {
    name: 'stub',
    remember: (fact) => facts.push(fact),
    recall: () => [],
    all: () => facts,
    get: (id) => facts.find((f) => f.id === id),
    update: () => false,
    delete: () => false,
    get count() {
      return facts.length;
    },
  };
}

/**
 * 构造子智能体端口集（工作区可指定，用于持久化用例）。
 * @param model 模型端口。
 * @param workspaceRoot 工作区根（缺省进程 cwd ⇒ 不写盘的用例）。
 * @returns 端口束。
 */
function makePorts(model: ModelPort, workspaceRoot: string = process.cwd()): SubagentPortsShape {
  const spill = new MemorySpill();
  return {
    model,
    tools: new RegistryToolPort(),
    storage: new MemoryStorage(),
    events: new RecordingEvents(),
    sandbox: new PassthroughSandbox(),
    approvals: new AutoApproval(),
    escalation: new DenyEscalation(),
    elevatedSandbox: new PassthroughSandbox(),
    spill,
    spiller: new ToolResultSpiller(spill, { maxInlineBytes: 1024, previewBytes: 256 }),
    workspaceRoot,
    maxSteps: 8,
    longTermMemory: makeLongTermStub(),
    goalMaxIterations: 10,
  };
}

/**
 * 在临时工作区里跑一段用例。
 * @param run 用例体（收到临时目录）。
 * @returns 无返回值（Promise 由用例自行 await）。
 */
async function withWorkspace(run: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'workflow-controlled-'));
  try {
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('受控条件执行（when）', () => {
  it('条件命中 ⇒ 执行；下游照跑', async () => {
    const model = new SwitchableModel();
    const runner = new WorkflowRunner(makePorts(model));
    const result = await runner.run({
      steps: [
        { id: 'A', prompt: '产出甲' },
        { id: 'B', prompt: '条件步', dependsOn: ['A'], when: { step: 'A', status: 'done' } },
      ],
    });
    assert.strictEqual(result.ok, true);
    const b = result.steps.find((step) => step.id === 'B');
    assert.strictEqual(b?.status, 'done');
    assert.ok((result.blackboard['B'] ?? '').includes('产出甲'), 'B 应看到 A 的产出');
  });

  it('条件不命中 ⇒ 记为 skipped（设计内跳过），下游照跑且整体判成功', async () => {
    const model = new SwitchableModel();
    const runner = new WorkflowRunner(makePorts(model));
    const result = await runner.run({
      steps: [
        { id: 'A', prompt: '产出甲' },
        {
          id: 'B',
          prompt: '仅当 A 失败才跑',
          dependsOn: ['A'],
          when: { step: 'A', status: 'failed' },
        },
        { id: 'C', prompt: '依赖 B', dependsOn: ['B'] },
      ],
    });
    const b = result.steps.find((step) => step.id === 'B');
    const c = result.steps.find((step) => step.id === 'C');
    assert.strictEqual(b?.status, 'skipped');
    assert.match(b?.error ?? '', /条件未成立/);
    assert.strictEqual(b?.ok, false, 'skipped 的 ok 为 false（未执行）');
    assert.strictEqual(c?.status, 'done', '设计内跳过**不得**阻断下游');
    assert.strictEqual(result.ok, true, '只有设计内跳过时整体仍判成功');
  });

  it('补救模式：上游 failed 时 when(status:"failed") 的补救步必须照跑', async () => {
    const model = new SwitchableModel('FAIL');
    const runner = new WorkflowRunner(makePorts(model));
    const result = await runner.run({
      steps: [
        { id: 'A', prompt: '正常步' },
        { id: 'B', prompt: 'FAIL 会失败', dependsOn: ['A'] },
        { id: 'FIX', prompt: '补救步', dependsOn: ['B'], when: { step: 'B', status: 'failed' } },
        { id: 'C', prompt: '依赖补救步', dependsOn: ['FIX'] },
      ],
    });
    const b = result.steps.find((step) => step.id === 'B');
    const fix = result.steps.find((step) => step.id === 'FIX');
    const c = result.steps.find((step) => step.id === 'C');
    assert.strictEqual(b?.status, 'failed');
    assert.strictEqual(fix?.status, 'done', '补救步必须执行（先条件裁决、后失败传播）');
    assert.strictEqual(c?.status, 'done');
    assert.strictEqual(result.ok, false, 'B 真失败 ⇒ 整体仍判失败（不因补救成功而掩盖）');
  });

  it('无 when 的步骤在上游失败时记 blocked，且原因与 skipped 措辞区分开', async () => {
    const model = new SwitchableModel('FAIL');
    const runner = new WorkflowRunner(makePorts(model));
    const result = await runner.run({
      steps: [
        { id: 'B', prompt: 'FAIL 会失败' },
        { id: 'C', prompt: '依赖 B', dependsOn: ['B'] },
      ],
    });
    const c = result.steps.find((step) => step.id === 'C');
    assert.strictEqual(c?.status, 'blocked');
    assert.match(c?.error ?? '', /上游依赖失败\/未完成（B）/);
    assert.strictEqual(result.ok, false);
  });

  it('规格非法（when 引用未声明依赖）⇒ fail-closed 抛错，不静默跑', async () => {
    const runner = new WorkflowRunner(makePorts(new SwitchableModel()));
    await assert.rejects(
      () =>
        runner.run({
          steps: [
            { id: 'A', prompt: 'a' },
            { id: 'B', prompt: 'b', dependsOn: ['A'] },
            { id: 'C', prompt: 'c', dependsOn: ['B'], when: { step: 'A', status: 'done' } },
          ],
        }),
      WorkflowSpecError,
    );
  });

  it('outputMatches：产出命中才执行', async () => {
    const runner = new WorkflowRunner(makePorts(new SwitchableModel()));
    const result = await runner.run({
      steps: [
        { id: 'A', prompt: '构建通过' },
        {
          id: 'FIX',
          prompt: '仅在构建失败时修复',
          dependsOn: ['A'],
          when: { step: 'A', status: 'done', outputMatches: '构建失败' },
        },
      ],
    });
    const fix = result.steps.find((step) => step.id === 'FIX');
    assert.strictEqual(fix?.status, 'skipped');
    assert.match(fix?.error ?? '', /产出不匹配/);
  });

  it('父会话取消 ⇒ 未执行步骤记 cancelled（阻断下游）', async () => {
    const controller = new AbortController();
    controller.abort();
    const runner = new WorkflowRunner(makePorts(new SwitchableModel()), {
      signal: controller.signal,
    });
    const result = await runner.run({
      steps: [
        { id: 'A', prompt: 'a' },
        { id: 'B', prompt: 'b', dependsOn: ['A'] },
      ],
    });
    assert.deepStrictEqual(
      result.steps.map((step) => step.status),
      ['cancelled', 'cancelled'],
    );
    assert.strictEqual(result.ok, false);
  });
});

describe('断点续跑（persist + resume）', () => {
  /** 两步工作流：A 成功、B 依赖 A。 */
  const DEF: WorkflowDef = {
    name: 'resume demo',
    steps: [
      { id: 'A', prompt: '产出甲' },
      { id: 'B', prompt: 'FAIL 触发失败', dependsOn: ['A'] },
    ],
  };

  it('未开启持久化 ⇒ 零写盘（库级默认不产生副作用）', async () => {
    await withWorkspace(async (root) => {
      const runner = new WorkflowRunner(makePorts(new SwitchableModel(), root));
      await runner.run(DEF);
      assert.strictEqual(existsSync(join(root, '.omniharness')), false);
    });
  });

  it('开启持久化 ⇒ 写运行日志；失败后 resume 复用 done 产出、重跑失败步并留下 attempt 留痕', async () => {
    await withWorkspace(async (root) => {
      const model = new SwitchableModel('FAIL');
      const first = await new WorkflowRunner(makePorts(model, root), { persist: true }).run(DEF);
      assert.strictEqual(first.ok, false);
      assert.deepStrictEqual(
        first.steps.map((step) => step.status),
        ['done', 'failed'],
      );
      const logPath = new WorkflowRunLog(root).pathOf(first.runId);
      assert.ok(existsSync(logPath), '运行日志必须落盘');

      // 「修好外部条件」后重试：第二次不再失败。
      model.failOn = undefined;
      const second = await new WorkflowRunner(makePorts(model, root), { persist: true }).resume(
        first.runId,
      );
      assert.strictEqual(second.ok, true);
      assert.deepStrictEqual(second.resumed, ['A'], '只有 done 的步骤被复用');
      assert.deepStrictEqual(
        second.steps.map((step) => step.status),
        ['done', 'done'],
      );
      const lineCount = (needle: string): number =>
        readFileSync(logPath, 'utf8')
          .split('\n')
          .filter((line) => line.includes(needle)).length;
      assert.strictEqual(lineCount('"id":"B","attempt":1'), 1, 'B 第一次尝试留痕');
      assert.strictEqual(
        lineCount('"id":"B","attempt":2'),
        1,
        'B 重跑记为第 2 次尝试（不覆盖历史）',
      );
      assert.strictEqual(lineCount('"id":"A","attempt":2'), 0, '复用的 A 不得再产生一次尝试');
    });
  });

  it('中断点（有 start 无 end）在 resume 时被重跑', async () => {
    await withWorkspace(async (root) => {
      const model = new SwitchableModel();
      const first = await new WorkflowRunner(makePorts(model, root), { persist: true }).run(DEF);
      assert.strictEqual(first.ok, true);
      // 模拟「B 跑到一半进程被杀」：手工追加一条 B 的 start 行（无 end）。
      const log = new WorkflowRunLog(root);
      log.appendStepStart(first.runId, 'B', 2);
      const resumed = await new WorkflowRunner(makePorts(model, root), { persist: true }).resume(
        first.runId,
      );
      assert.ok(resumed.resumed.includes('A'), 'A 仍复用');
      assert.deepStrictEqual(
        resumed.steps.map((step) => step.status),
        ['done', 'done'],
      );
    });
  });

  it('规格与 runId 记录不一致 ⇒ 拒绝续跑（不把两份定义拼在一起）', async () => {
    await withWorkspace(async (root) => {
      const model = new SwitchableModel();
      const first = await new WorkflowRunner(makePorts(model, root), { persist: true }).run(DEF);
      const other: WorkflowDef = { steps: [{ id: 'A', prompt: '改过的定义' }] };
      await assert.rejects(
        () =>
          new WorkflowRunner(makePorts(model, root), { persist: true }).resume(first.runId, other),
        /规格与本次传入的 spec 不一致/,
      );
    });
  });

  it('runId 不存在 ⇒ 明确报错', async () => {
    await withWorkspace(async (root) => {
      await assert.rejects(
        () =>
          new WorkflowRunner(makePorts(new SwitchableModel(), root), { persist: true }).resume(
            'wf-nope',
          ),
        /找不到运行日志/,
      );
    });
  });
});
