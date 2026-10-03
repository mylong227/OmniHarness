/**
 * 回合验证状态的一等语义（G3-V2，2026-10-03 第六轮）。
 *
 * ## 缺陷形态（本文件先复现、再钉住修复）
 *
 * 完成闸门每回合**至多跑一次**（有界设计）。模型首次宣告完成时若验证未通过，闸门回灌失败摘要并再给一步；
 * 当模型**第二次**宣告完成时，`TurnRunner` 只能放行——而放行被上层读成了"验证通过"。
 * 于是"改坏了代码 + 两次宣布完成"就能拿到一个看起来干净的 `ok`，这正是假完成的落点。
 *
 * ## 修好后的口径
 *
 * 二次宣告完成时记 `verificationState = 'unverified'`（并在事件流留一条 system 说明），
 * 经 `TurnOutcome` → `AgentResult` 如实上抛。**`'unverified'` 不得读成通过**。
 *
 * ## 为什么用「工作区自带失败测试命令」而不是 `selfVerify.enabled`
 *
 * `TurnCompletionGateFactory` 在 `selfVerify.enabled === true` 时走的是 **`status` 闸门**（读工具端口的
 * 写时结论）；要驱动 `turn-end` 闸门（回合末现跑一次命令）必须**不启用写时自验证**、且工作区能探测出
 * 测试命令。故本文件给临时工作区写 `package.json` + 一个必然失败/成功的 `check.js`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Agent } from '../../src/core/agent.js';
import { ScriptedModel, type ScriptStep } from '../../src/core/scriptedModel.js';
import { ConfigFactory } from '../../src/config/configFactory.js';
import { Runtime } from '../../src/composition/runtime.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';
import { TurnCompletionGateFactory } from '../../src/adapters/tool/verify/turnCompletionGateFactory.js';
import { TOOL_NAMES } from '../../src/ports/tool/toolNames.js';
import type { SessionEvent } from '../../src/ports/runtime/event.js';

/**
 * 造一个带测试命令的工作区（`check.js` 的退出码决定"验证"通过与否）。
 * @param exitCode `check.js` 的退出码（非 0 ＝ 验证必然失败）。
 * @returns 工作区绝对路径。
 */
function workspaceWithTest(exitCode: number): string {
  const ws = mkdtempSync(join(tmpdir(), 'omni-vstate-'));
  writeFileSync(join(ws, 'check.js'), `process.exit(${String(exitCode)});\n`);
  writeFileSync(
    join(ws, 'package.json'),
    JSON.stringify({ name: 'probe', scripts: { test: 'node check.js' } }),
  );
  return ws;
}

/**
 * 跑「改文件 → 宣布完成 →（闸门拦下）→ 再宣布完成」的脚本回合。
 * @param ws 工作区根。
 * @returns 运行结果与事件流，以及闸门种类。
 */
async function runTwiceClaim(ws: string): Promise<{
  result: Awaited<ReturnType<Agent['runTask']>>;
  events: readonly SessionEvent[];
  gateKind: string | undefined;
}> {
  const script: readonly ScriptStep[] = [
    {
      toolCalls: [
        {
          id: 'w1',
          name: TOOL_NAMES.writeFile,
          arguments: { path: join(ws, 'a.ts'), content: 'export const a = 1;\n' },
        },
      ],
    },
    { text: '我改好了' },
    { text: '真的改好了' },
  ];
  const config = ConfigFactory.build({
    workspaceRoot: ws,
    maxSteps: 6,
    model: new ScriptedModel(script, '收尾'),
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
  });
  const runtime = Runtime.createRuntime(config);
  const gateKind = TurnCompletionGateFactory.of({
    tools: runtime.tools,
    selfVerify: undefined,
    workspaceRoot: ws,
  })?.kind;
  const result = await new Agent(runtime).runTask('改一下 a.ts');
  return { result, events: result.events, gateKind };
}

/**
 * 事件流里是否有"未验证"留痕。
 * @param events 事件数组。
 * @returns 存在为 true。
 */
function hasUnverifiedNote(events: readonly SessionEvent[]): boolean {
  return events.some(
    (e) =>
      e.type === 'system' &&
      String((e.payload as { content?: unknown }).content ?? '').includes('未验证'),
  );
}

test('① 验证恒失败 + 二次宣告完成 ⇒ 状态必须是 unverified（绝不 not-run）', async () => {
  const ws = workspaceWithTest(1);
  try {
    const { result, events, gateKind } = await runTwiceClaim(ws);
    assert.strictEqual(gateKind, 'turn-end', '前置：本用例必须走回合末现跑命令的闸门');
    assert.strictEqual(
      result.verificationState,
      'unverified',
      `二次宣告完成仍未核验通过时必须记 unverified，实得 ${String(result.verificationState)}`,
    );
    assert.ok(
      hasUnverifiedNote(events),
      '事件流里必须有「未验证」留痕（否则该状态对审计与 UI 不可见）',
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('② 工作区探测不到测试命令 ⇒ 不设闸门 ⇒ not-run，且不得留下"未验证"假警报', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'omni-vstate-none-'));
  try {
    const { result, events, gateKind } = await runTwiceClaim(ws);
    assert.strictEqual(gateKind, undefined, '前置：无测试命令时不应设闸门');
    assert.strictEqual(result.verificationState, 'not-run');
    assert.ok(!hasUnverifiedNote(events), '没闸门就不该产生"未验证"留痕');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('③ 验证通过 ⇒ 闸门不拦 ⇒ not-run（当前契约不区分"通过"与"未触发"，已在类型注释登记）', async () => {
  const ws = workspaceWithTest(0);
  try {
    const { result, events, gateKind } = await runTwiceClaim(ws);
    assert.strictEqual(gateKind, 'turn-end', '前置：闸门存在，只是命令通过');
    assert.notStrictEqual(
      result.verificationState,
      'failed',
      '通过的回合不得被标成 failed（否则是假警报，会让人不再相信这个字段）',
    );
    assert.notStrictEqual(result.verificationState, 'unverified', '通过就不该报未验证');
    assert.ok(!hasUnverifiedNote(events), '通过的回合不该有"未验证"留痕');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
