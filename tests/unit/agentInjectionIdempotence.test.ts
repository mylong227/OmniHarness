/**
 * 「每会话一次」注入的回归测试（技能 / 长期记忆 primer）。
 *
 * 缺陷背景（2026-09-19 实测）：`resume`/`fork` 会先 hydrate 历史，而注入原先**无条件**执行
 * ⇒ 同一段技能指令在长会话里出现 N 次（第 3 轮就有 3 份）。后果两层：① 上下文与 token 白烧；
 * ② 模型反复读到同样的「规则」，反而稀释注意力。本文件钉住「一轮一次、一会话一份」。
 *
 * 断言走**真实装配**（ConfigFactory → createRuntime → Agent → MemoryStorage），不 mock 注入路径。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigFactory } from '../../src/config/configFactory.js';
import { createRuntime } from '../../src/core/runtime.js';
import { Agent } from '../../src/core/agent.js';
import { MockModel } from '../../src/adapters/model/mockModel.js';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.js';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.js';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.js';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.js';
import type { SessionEvent } from '../../src/ports/runtime/event.js';

/** 技能注入产物的特征前缀（与 SkillRegistry.render 同源）。 */
const SKILL_MARKER = '# 技能：';

/** 建一个带技能池的工作区配置。 */
function workspaceWithSkill(): { readonly dir: string; readonly agent: Agent } {
  const dir = mkdtempSync(join(tmpdir(), 'omni-inject-'));
  const config = ConfigFactory.build({
    workspaceRoot: dir,
    maxSteps: 2,
    model: new MockModel(),
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
    skills: [
      {
        name: 'inject-once-probe',
        description: '注入次数探针',
        instructions: 'INJECT-ONCE-PROBE-MARKER：这条指令在整个会话里只应出现一次。',
        tags: ['injectprobe'],
      },
    ],
  });
  return { dir, agent: new Agent(createRuntime(config)) };
}

/** 统计事件流里技能注入 system 事件的条数。 */
function skillInjectionCount(events: readonly SessionEvent[]): number {
  return events.filter((event) => {
    if (event.type !== 'system') return false;
    const payload = event.payload as { content?: unknown } | null | undefined;
    const content = payload === null || payload === undefined ? undefined : payload.content;
    return typeof content === 'string' && content.startsWith(SKILL_MARKER);
  }).length;
}

test('技能注入一会话一次：连跑三轮后事件流里只有一份技能指令', async () => {
  const { dir, agent } = workspaceWithSkill();
  try {
    // 首轮：命中技能（prompt 含技能名）⇒ 注入一次。
    const first = await agent.runTask('请用 inject-once-probe 处理这件事');
    assert.strictEqual(
      skillInjectionCount(first.events),
      1,
      '首轮应恰好注入一次技能（命中技能名即注入）',
    );

    // 第二、三轮：resume 会 hydrate 历史；历史里已有注入 ⇒ 不得再注入。
    const second = await agent.resume(first.sessionId, '继续，再用一次 inject-once-probe');
    const third = await agent.resume(first.sessionId, '第三轮，仍然提到 inject-once-probe');
    assert.strictEqual(
      skillInjectionCount(second.events),
      1,
      `第二轮不得重复注入技能（实测 ${String(skillInjectionCount(second.events))} 份）`,
    );
    assert.strictEqual(
      skillInjectionCount(third.events),
      1,
      `第三轮不得重复注入技能（实测 ${String(skillInjectionCount(third.events))} 份）`,
    );

    // 落盘与内存视图一致（重放同一事实源也是 1 份）。
    const replayed = await agent.replay(first.sessionId);
    assert.strictEqual(skillInjectionCount(replayed), 1, '持久化后的历史同样只应有一份注入');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('未命中技能时不注入（零噪声），且不影响后续轮次的会话可用性', async () => {
  const { dir, agent } = workspaceWithSkill();
  try {
    const first = await agent.runTask('把数组按长度排序');
    assert.strictEqual(skillInjectionCount(first.events), 0, '未命中不得注入技能文本');
    const second = await agent.resume(first.sessionId, '再排一次');
    assert.strictEqual(skillInjectionCount(second.events), 0, '后续轮次同样不得凭空注入');
    assert.strictEqual(second.sessionId, first.sessionId, 'resume 必须复用同一会话 id');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fork 到新会话：历史随行带入注入，故新分支不重复注入（一份随行 + 零新增）', async () => {
  const { dir, agent } = workspaceWithSkill();
  try {
    const source = await agent.runTask('请用 inject-once-probe 处理');
    assert.strictEqual(skillInjectionCount(source.events), 1);
    const forked = await agent.fork(source.sessionId, '分叉后继续用 inject-once-probe');
    assert.notStrictEqual(forked.sessionId, source.sessionId, 'fork 必须产生新会话 id');
    assert.strictEqual(
      skillInjectionCount(forked.events),
      1,
      'fork 的历史里已带一份注入，不得再加一份',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
