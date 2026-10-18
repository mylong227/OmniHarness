/**
 * 「**任务完成**才是终止条件，不是步数配额」的判据（2026-10-15 产品口径）。
 *
 * ## 为什么立这条
 *
 * 实证（`sess_mv9nl59c`）：一个"定位重、落盘轻"的真实任务把 48 步全花在读取/检索上，
 * **写入一步没跑**就结束了——报告只能以"下一轮再落盘"收尾。此前两轮的处置都是**把配额抬大**
 * （16→32→48），而问题不在配额大小，在于**拿配额当终止条件**。
 * 故默认改为 0 = 不限，终止交给：模型产出结论（完成闸门）/ token 与成本预算 / LoopGuard 行为护栏 / 取消。
 *
 * ## 判据
 *
 * | # | 判据 | 坏掉的后果 |
 * | --- | --- | --- |
 * | ① | 缺省值就是"不限"（主会话与子代理同一口径） | 有人把默认值改回某个数 ⇒ 同类事故重现 |
 * | ② | 60 步的真实回合在缺省下**跑得完**且 `truncated=false` | 改回固定配额 ⇒ 长任务在中途被砍 |
 * | ③ | 显式给上限时**仍按步数截断**且如实标 `truncated` | 有界性彻底消失（CI/成本封顶失效） |
 * | ④ | 不限步数下，**行为护栏熔断也算"没做完"**（`truncated=true`） | 被熔断的回合被上层读成"完成"（假信号） |
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Agent } from '../../src/core/agent.ts';
import { ScriptedModel, type ScriptStep } from '../../src/core/scriptedModel.ts';
import { ConfigFactory } from '../../src/config/configFactory.ts';
import { Runtime } from '../../src/composition/runtime.ts';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.ts';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.ts';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.ts';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.ts';
import { TOOL_NAMES } from '../../src/ports/tool/toolNames.ts';
import { CliDefaults } from '../../src/cli/argParser.ts';
import { DEFAULT_SUBAGENT_MAX_STEPS } from '../../src/subagent/subagentTypes.ts';

// 本文件只测步进终止语义：关掉 repo-map（索引整仓既慢又与断言无关）。
process.env.OMNI_REPO_MAP = '0';

/** 默认配额曾长期是 48：用它当"旧行为"的分界线。 */
const LEGACY_DEFAULT_STEPS = 48;

/** 长任务脚本：n 个工具步 + 收尾文本（**参数逐条递增**，避免被 LoopGuard 的重复检测熔断）。 */
function longScript(toolSteps: number): readonly ScriptStep[] {
  return [
    ...Array.from({ length: toolSteps }, (_unused, i) => ({
      toolCalls: [
        {
          id: `c${String(i)}`,
          name: TOOL_NAMES.glob,
          arguments: { pattern: `probe-${String(i)}.ts` },
        },
      ],
    })),
    { text: '完成' },
  ];
}

/**
 * 跑一个回合。
 * @param script 模型脚本
 * @param over 额外配置（如 `maxSteps`）；**缺省即 `maxSteps: 0`（不限）**，与 CLI 缺省同一口径
 * @returns 回合结果
 */
async function runTurn(
  script: readonly ScriptStep[],
  over: Record<string, unknown> = {},
): Promise<{ steps: number; truncated: boolean; aborted: boolean; finalText?: string }> {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'omni-step-policy-'));
  try {
    const config = ConfigFactory.build({
      workspaceRoot,
      maxSteps: 0,
      model: new ScriptedModel(script, '兜底'),
      storage: new MemoryStorage(),
      approvals: new AutoApproval(),
      sandbox: new PassthroughSandbox(),
      events: new SilentEventPort(),
      ...over,
    });
    const result = await new Agent(Runtime.createRuntime(config)).runTask('跑很多步');
    return {
      steps: result.steps,
      // 端口上这两个标记是可选的；未设置即当作"没有这个事实"——判据要的是显式 true。
      truncated: result.truncated === true,
      aborted: result.aborted === true,
      ...(result.finalText !== undefined ? { finalText: result.finalText } : {}),
    };
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

test('① 缺省即"不限"：主会话与子代理的步数上限默认都是 0', () => {
  assert.strictEqual(
    CliDefaults.maxSteps,
    0,
    'CLI 缺省必须是 0 = 不限（终止以任务完成为准）；正数会把长任务砍在中途',
  );
  assert.strictEqual(
    DEFAULT_SUBAGENT_MAX_STEPS,
    0,
    '子代理同一口径：默认不限（历史上 12 的配额造成过"交付不完整却称已完成"）',
  );
});

test('② 60 步的真实回合在缺省下跑得完，且**不被判成截断**', async () => {
  const steps = LEGACY_DEFAULT_STEPS + 12; // 60 个工具步：超过旧默认 48，用来暴露"配额当终止条件"的旧行为
  const result = await runTurn(longScript(steps));
  // `steps` 把「产出结论的那一步」也算进去，故期望是 工具步 + 1。
  assert.strictEqual(
    result.steps,
    steps + 1,
    `缺省应不限步数：脚本 ${String(steps)} 个工具步应全部跑完（实测 ${String(result.steps)} 步 ⇒ 又被配额砍了）`,
  );
  assert.ok(
    result.steps > LEGACY_DEFAULT_STEPS,
    `必须越过旧的 48 步缺省（实测 ${String(result.steps)}）——否则长任务仍会在中途被砍`,
  );
  assert.strictEqual(result.truncated, false, '自然收敛（模型给出了结论）不得标成截断');
  assert.strictEqual(result.aborted, false);
});

test('③ 显式给上限时仍按步数截断（有界性没被删掉）', async () => {
  const result = await runTurn(longScript(LEGACY_DEFAULT_STEPS + 12), { maxSteps: 3 });
  assert.strictEqual(result.steps, 3, '显式 maxSteps=3 必须精确截断在 3 步');
  assert.strictEqual(
    result.truncated,
    true,
    '被步数上限截断必须如实标 truncated（上层据此不说"做完了"）',
  );
});

test('④ 不限步数时，行为护栏熔断同样算"没做完"（不能只按步数判）', async () => {
  // 同一个调用**逐字重复** ⇒ 命中 LoopGuard 的精确重复检测（先纠偏、连续触达上限即熔断）。
  const repeat: readonly ScriptStep[] = Array.from({ length: 40 }, (_unused, i) => ({
    toolCalls: [{ id: `r${String(i)}`, name: TOOL_NAMES.glob, arguments: { pattern: 'same.ts' } }],
  }));
  const result = await runTurn(repeat);
  assert.strictEqual(result.aborted, true, '重复调用应触发 LoopGuard 熔断');
  assert.ok(result.steps < 40, `熔断应在脚本跑完前发生（实测 ${String(result.steps)} 步）`);
  assert.strictEqual(
    result.truncated,
    true,
    '被熔断的回合必须标 truncated=true —— 否则上层会把"没做完"读成"完成"',
  );
});
