/**
 * 长时程协议的**真实 agent 接线**判据（P0-2/P1-2，2026-10-24）。
 *
 * 断言走真实装配（ConfigFactory → Runtime → Agent → MockModel），不 mock 协议：
 *  ① `OMNI_LONG_HORIZON=1` 时开场注入极简 primer、落状态件、回合末写 progress；
 *  ② 复杂任务在未设 env 时按 TaskComplexityClassifier 自动启用；
 *  ③ 配置了 verifyCommand 且未通过时，收尾检查清单**恰好注入一次**；
 *  ④ resume 复用同一任务目录（不因提示变化而另起任务）。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigFactory } from '../../src/config/configFactory.ts';
import { Runtime } from '../../src/composition/runtime.ts';
import { Agent } from '../../src/core/agent.ts';
import { MockModel } from '../../src/adapters/model/mockModel.ts';
import { MemoryStorage } from '../../src/adapters/storage/memoryStorage.ts';
import { AutoApproval } from '../../src/adapters/approval/autoApproval.ts';
import { PassthroughSandbox } from '../../src/adapters/sandbox/passthroughSandbox.ts';
import { SilentEventPort } from '../../src/adapters/event/silentEventPort.ts';
import type { SessionEvent } from '../../src/ports/runtime/event.ts';

/** 长时程相关的 4 个环境变量（测试前后恢复，避免污染其它文件）。 */
const ENV_KEYS = [
  'OMNI_LONG_HORIZON',
  'OMNI_LONG_HORIZON_TASK',
  'OMNI_LONG_HORIZON_VERIFY',
] as const;

/**
 * 在本测试作用域内设置 env，并在结束时恢复原值。
 * @param values 要设置的值（undefined 表示删除）。
 * @returns 恢复函数。
 */
function withEnv(
  values: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>,
): () => void {
  const previous = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    previous.set(key, process.env[key]);
    const next = values[key];
    if (next === undefined) delete process.env[key];
    else process.env[key] = next;
  }
  return () => {
    for (const key of ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/** 真实 agent（MockModel：第一步 shell 工具调用、之后固定完成文本）。 */
function agentIn(root: string): Agent {
  const config = ConfigFactory.build({
    workspaceRoot: root,
    maxSteps: 6,
    model: new MockModel(),
    storage: new MemoryStorage(),
    approvals: new AutoApproval(),
    sandbox: new PassthroughSandbox(),
    events: new SilentEventPort(),
  });
  return new Agent(Runtime.createRuntime(config));
}

/** 任务目录列表（`.omniharness/tasks/*`）。 */
function taskDirs(root: string): readonly string[] {
  const dir = join(root, '.omniharness', 'tasks');
  return existsSync(dir) ? readdirSync(dir) : [];
}

/** 读唯一任务目录下的文件。 */
function readOnlyTaskFile(root: string, name: string): string {
  const dirs = taskDirs(root);
  assert.strictEqual(dirs.length, 1, `应有且只有一个任务目录，实际：${dirs.join(', ')}`);
  const path = join(root, '.omniharness', 'tasks', dirs[0] as string, name);
  assert.ok(existsSync(path), `缺少 ${name}`);
  return readFileSync(path, 'utf8');
}

/** 统计含指定标记的 user 事件条数（收尾检查清单注入走 user 消息）。 */
function userMarkerCount(events: readonly SessionEvent[], marker: string): number {
  return events.filter((event) => {
    if (event.type !== 'user') return false;
    const content = (event.payload as { content?: unknown }).content;
    return typeof content === 'string' && content.includes(marker);
  }).length;
}

/** primer 事件（system 且含长时程标记）。 */
function primerEvents(events: readonly SessionEvent[]): readonly SessionEvent[] {
  return events.filter((event) => {
    if (event.type !== 'system') return false;
    const content = (event.payload as { content?: unknown }).content;
    return typeof content === 'string' && content.startsWith('【长时程任务】');
  });
}

test('显式开关：primer 注入 system、状态件落盘、回合末 progress 记录提示/失败/验证', async () => {
  const root = mkdtempSync(join(tmpdir(), 'omni-lh-wiring-'));
  const restore = withEnv({
    OMNI_LONG_HORIZON: '1',
    OMNI_LONG_HORIZON_VERIFY: 'node -e "process.exit(0)"',
    OMNI_LONG_HORIZON_TASK: undefined,
  });
  try {
    const agent = agentIn(root);
    const result = await agent.runTask('把数组按长度排序');
    const primers = primerEvents(result.events);
    assert.strictEqual(primers.length, 1, '开场应恰好注入一条 primer');
    const primerText = (primers[0]?.payload as { content: string }).content;
    assert.match(primerText, /功能: 0\/1/u);
    assert.match(primerText, /验证: node -e/u);
    assert.ok(primerText.length < 700, 'primer 必须极简（不塞历史）');

    assert.strictEqual(taskDirs(root).length, 1, '应创建一个任务目录');
    const features = JSON.parse(readOnlyTaskFile(root, 'features.json')) as {
      readonly verifyCommand: string;
      readonly features: readonly unknown[];
    };
    assert.strictEqual(features.verifyCommand, 'node -e "process.exit(0)"');
    assert.strictEqual(features.features.length, 1);

    const progress = readOnlyTaskFile(root, 'progress.md');
    assert.match(progress, /- 用户提示: 把数组按长度排序/u);
    assert.match(progress, /- 工具失败: 0/u);
    assert.match(progress, /- 验证: passed/u);
  } finally {
    restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test('自动启用：未设 env 但任务被判复杂时同样注入 primer 并写进度', async () => {
  const root = mkdtempSync(join(tmpdir(), 'omni-lh-auto-'));
  const restore = withEnv({
    OMNI_LONG_HORIZON: undefined,
    OMNI_LONG_HORIZON_TASK: undefined,
    OMNI_LONG_HORIZON_VERIFY: undefined,
  });
  try {
    const agent = agentIn(root);
    const prompt =
      '实现一个排序函数并修复两个 bug：先写测试，然后重构 src/a.ts 与 src/b.ts，最后跑验证';
    const result = await agent.runTask(prompt);
    assert.strictEqual(primerEvents(result.events).length, 1, '复杂任务应自动注入 primer');
    const progress = readOnlyTaskFile(root, 'progress.md');
    assert.match(progress, /- 验证: skipped（未配置 verifyCommand）/u);
  } finally {
    restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test('收尾检查清单：verify 未通过时恰好注入一次"先验证再结束"，并记 failed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'omni-lh-checklist-'));
  const restore = withEnv({
    OMNI_LONG_HORIZON: '1',
    OMNI_LONG_HORIZON_VERIFY: 'node -e "process.exit(1)"',
    OMNI_LONG_HORIZON_TASK: undefined,
  });
  try {
    const agent = agentIn(root);
    const result = await agent.runTask('实现一个小工具');
    assert.strictEqual(
      userMarkerCount(result.events, '【收尾检查清单】'),
      1,
      '检查清单必须恰好注入一次（防死循环）',
    );
    const checklist = result.events
      .filter((event) => event.type === 'user')
      .map((event) => (event.payload as { content?: string }).content ?? '')
      .find((content) => content.includes('【收尾检查清单】'));
    assert.match(String(checklist), /验证未通过/u);
    assert.match(readOnlyTaskFile(root, 'progress.md'), /- 验证: failed/u);
  } finally {
    restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test('resume：复用同一任务目录（提示变化不另起任务），progress 追加而非覆盖', async () => {
  const root = mkdtempSync(join(tmpdir(), 'omni-lh-resume-'));
  const restore = withEnv({
    OMNI_LONG_HORIZON: '1',
    OMNI_LONG_HORIZON_VERIFY: undefined,
    OMNI_LONG_HORIZON_TASK: undefined,
  });
  try {
    const agent = agentIn(root);
    const first = await agent.runTask('把数组按长度排序');
    await agent.resume(first.sessionId, '继续把边界情况补上');
    assert.strictEqual(taskDirs(root).length, 1, 'resume 必须复用同一任务目录');
    const progress = readOnlyTaskFile(root, 'progress.md');
    const entries = (progress.match(/^## /gmu) ?? []).length;
    assert.strictEqual(entries, 2, `两轮应各写一条进度，实际 ${String(entries)} 条`);
    assert.match(progress, /继续把边界情况补上/u);
  } finally {
    restore();
    rmSync(root, { recursive: true, force: true });
  }
});
