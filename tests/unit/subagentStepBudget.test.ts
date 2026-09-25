// `--subagent-max-steps` 覆盖面回归（次级线索 4a）。
//
// 修复背景：该旋钮此前只经 `SubagentOrchestrator` 生效于 subagent 一条路径；
// run_goal / run_workflow 的子代 runtime 直接读主会话 `maxSteps`——同一旋钮两条口径，
// 声明支持却半程失效。本测试从**组合根**（ConfigFactory + createRuntime）出发，
// 只经公开工具入口 `run_workflow` 观测子代实际可用步数，钉住「三条路径共用同一份子代预算」。
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ModelOutput, ModelPort, ModelRequest } from '../../src/ports/model/model.js';
import { ConfigFactory } from '../../src/config/configFactory.js';
import { Runtime } from '../../src/composition/runtime.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';
import { DEFAULT_SUBAGENT_MAX_STEPS } from '../../src/subagent/subagentTypes.js';
import type { ToolPort } from '../../src/ports/tool/tool.js';

// 关掉 repo-map 注入：本文件只测步数预算接线，索引整个仓库既慢又与断言无关。
process.env.OMNI_REPO_MAP = '0';

/** 主会话步数（故意小于默认子代步数，以便区分「用了哪一份预算」）。 */
const PARENT_MAX_STEPS = 8;

/**
 * 步数观测模型：子代每次请求都发一个「参数递增」的工具调用（参数递增可绕开
 * LoopGuard 的同调用重复检测），直到步数用尽后由兜底总结收尾。
 */
class StepLoopModel implements ModelPort {
  /** 端口要求适配器名（标明它是"步骤循环"假模型）。 */
  public readonly name = 'step-loop';
  /** 子代（工作流步骤）模型调用次数。 */
  public childCalls = 0;

  /**
   * 每个子步都请求一次工具（驱动步进循环），直到无工具可请求时收尾。
   *
   * @param request 模型请求
   * @returns 需要工具时给出工具调用，否则给出文本收尾
   */
  public async generate(request: ModelRequest): Promise<ModelOutput> {
    if (request.tools.some((tool) => tool.name === 'subagent')) {
      return { text: '父会话不参与本测试' };
    }
    this.childCalls += 1;
    if (request.tools.length === 0) {
      // 无工具轮＝TurnRunner 的兜底总结调用。
      return { text: '兜底总结' };
    }
    return {
      toolCalls: [
        { id: `c${this.childCalls}`, name: 'noop_probe', arguments: { n: this.childCalls } },
      ],
    };
  }
}

/**
 * 按组合根装配出工具端口（含 run_workflow）。
 * @param subagentMaxSteps 子代步数上限（undefined＝未配置，走默认值）
 * @returns 观测模型与运行时的工具端口
 */
function buildTools(subagentMaxSteps?: number): { model: StepLoopModel; tools: ToolPort } {
  const model = new StepLoopModel();
  const config = ConfigFactory.build({
    workspaceRoot: process.cwd(),
    maxSteps: PARENT_MAX_STEPS,
    ...(subagentMaxSteps === undefined ? {} : { subagentMaxSteps }),
    model,
    storage: new MemoryStorage(),
    events: new SilentEventPort(),
    spillAdapter: 'memory',
  });
  return { model, tools: Runtime.createRuntime(config).tools };
}

describe('--subagent-max-steps 覆盖 run_workflow 子步', () => {
  it('子步步数 = subagentMaxSteps（而非主会话 maxSteps）', async () => {
    const { model, tools } = buildTools(1);
    const result = await tools.execute(
      {
        id: 'c1',
        name: 'run_workflow',
        arguments: { spec: { steps: [{ id: 'A', prompt: '步进' }] } },
      },
      { sessionId: 'parent', workspaceRoot: process.cwd() },
    );
    assert.strictEqual(result.ok, true, `工作流应成功，实际: ${result.error ?? ''}`);
    // 1 步工具调用 + 1 次兜底总结；若误用主会话 maxSteps(8) 则会是 9 次。
    assert.strictEqual(
      model.childCalls,
      2,
      `子步应受 subagentMaxSteps=1 约束（实测模型调用 ${model.childCalls} 次）`,
    );
  });

  it('未配置时子步用默认子代步数（而非主会话 maxSteps）', async () => {
    const { model, tools } = buildTools();
    const result = await tools.execute(
      {
        id: 'c1',
        name: 'run_workflow',
        arguments: { spec: { steps: [{ id: 'A', prompt: '步进' }] } },
      },
      { sessionId: 'parent', workspaceRoot: process.cwd() },
    );
    assert.strictEqual(result.ok, true, `工作流应成功，实际: ${result.error ?? ''}`);
    assert.strictEqual(
      model.childCalls,
      DEFAULT_SUBAGENT_MAX_STEPS + 1,
      `子步应用默认子代步数 ${DEFAULT_SUBAGENT_MAX_STEPS}（实测 ${model.childCalls} 次）`,
    );
  });
});
