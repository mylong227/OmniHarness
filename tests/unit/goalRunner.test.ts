import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ModelOutput, ModelPort, ModelRequest } from '../../src/ports/model.js';
import type { AgentResult } from '../../src/core/agent.js';
import type { Agent } from '../../src/core/agent.js';
import { GoalRunner } from '../../src/autonomy/goalRunner.js';
import { GoalChecker } from '../../src/autonomy/goalChecker.js';

/** 返回固定达成判定的模型桩（用于驱动 GoalRunner 的判定器）。 */
class VerdictModel implements ModelPort {
  readonly name = 'verdict';

  constructor(private readonly verdict: 'YES 已完成' | 'NO 未完成') {}

  async generate(_request: ModelRequest): Promise<ModelOutput> {
    return { text: this.verdict };
  }
}

/** 假 Agent：记录 runTask / resume 调用，产出可控 finalText。 */
class FakeAgent {
  runTaskCalls = 0;
  resumeCalls = 0;
  readonly prompts: string[] = [];
  private lastSession = 'sess-init';

  async runTask(prompt: string): Promise<AgentResult> {
    this.runTaskCalls += 1;
    this.lastSession = `sess-${this.runTaskCalls}`;
    this.prompts.push(prompt);
    return {
      sessionId: this.lastSession,
      finalText: `进展${this.runTaskCalls}`,
      steps: 1,
      events: [],
    };
  }

  async resume(sessionId: string, prompt: string): Promise<AgentResult> {
    this.resumeCalls += 1;
    this.prompts.push(prompt);
    return { sessionId, finalText: `续推${this.resumeCalls}`, steps: 1, events: [] };
  }
}

describe('GoalRunner', () => {
  it('首轮即达成：只跑 runTask，不续跑', async () => {
    const agent = new FakeAgent();
    const runner = new GoalRunner(
      agent as unknown as Agent,
      new GoalChecker(new VerdictModel('YES 已完成')),
      {
        maxIterations: 3,
      },
    );
    const result = await runner.run('达成目标X');

    assert.strictEqual(result.achieved, true);
    assert.strictEqual(result.iterations, 1);
    assert.strictEqual(agent.runTaskCalls, 1);
    assert.strictEqual(agent.resumeCalls, 0);
    assert.match(result.reason, /达成/);
  });

  it('始终未达成：跑到上限后停止，不无限循环', async () => {
    const agent = new FakeAgent();
    const runner = new GoalRunner(
      agent as unknown as Agent,
      new GoalChecker(new VerdictModel('NO 未完成')),
      {
        maxIterations: 3,
      },
    );
    const result = await runner.run('达成目标Y');

    assert.strictEqual(result.achieved, false);
    assert.strictEqual(result.iterations, 3);
    assert.strictEqual(agent.runTaskCalls, 1, '首轮一次 runTask');
    assert.strictEqual(agent.resumeCalls, 2, '此后每轮一次 resume，共 maxIterations-1');
  });

  it('中途达成：在达成轮停止，不浪费后续迭代', async () => {
    // 第三轮判达成：用脚本模型按调用次数切换。
    let calls = 0;
    const model: ModelPort = {
      name: 'flip',
      async generate(_request: ModelRequest): Promise<ModelOutput> {
        calls += 1;
        return { text: calls >= 3 ? 'YES 已完成' : 'NO 未完成' };
      },
    };
    const agent = new FakeAgent();
    const runner = new GoalRunner(agent as unknown as Agent, new GoalChecker(model), {
      maxIterations: 5,
    });
    const result = await runner.run('达成目标Z');

    assert.strictEqual(result.achieved, true);
    assert.strictEqual(result.iterations, 3);
    assert.strictEqual(agent.runTaskCalls + agent.resumeCalls, 3);
  });

  it('跨迭代复用同一会话 ID（模型拥有完整上下文）', async () => {
    const agent = new FakeAgent();
    const runner = new GoalRunner(
      agent as unknown as Agent,
      new GoalChecker(new VerdictModel('NO 未完成')),
      {
        maxIterations: 2,
      },
    );
    const result = await runner.run('达成目标W');
    assert.strictEqual(result.sessionId, 'sess-1', 'resume 沿用首轮 sessionId');
  });
});
