// 聊天模式路由判据（2026-10-31）：队列模式 / 插话模式在**控制器层**的分流。
//
// 这一层是本次需求的"政策点"：
//   · 队列模式：在飞时发送只入队，回合收尾后按 FIFO 续发；「停止」暂停队列，不自动续跑；
//   · 插话模式：相关 ⇒ 并入当前回合（steering，附件一起送）；无关 ⇒ 中断当前回合，
//     本条内容插队成为新任务；
//   · 两种模式都必须保住附件（图片/视频/GIF/文件）——不能只转文本。
//
// 直跑 `npx vitest run --project web web/test/chatModeRouting.test.ts`。
import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AppHost, AppServices } from '../src/ui/controllers/AppController.ts';
import type { SessionController } from '../src/ui/controllers/SessionController.ts';
import type { TurnRunResult } from '../src/types/models.ts';

const { ComposerController } = await import('../src/ui/controllers/ComposerController.ts');

/** 可控延迟（模拟在飞回合）。 */
function deferred<T = unknown>() {
  let resolve!: (v: T | PromiseLike<T>) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 让出一轮宏任务：`drainQueue` 里是 `void runRound(...)`，需要事件循环滚动一次。 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** API 桩（记录调用）。 */
interface ApiStub {
  readonly runCalls: Record<string, unknown>[];
  readonly interjectCalls: Record<string, unknown>[];
  readonly configCalls: Record<string, unknown>[];
  runTurn: (params: Record<string, unknown>) => Promise<TurnRunResult>;
  interjectTurn: (params: Record<string, unknown>) => Promise<unknown>;
  steerTurn: () => Promise<{ ok: boolean }>;
  abortTurn: () => Promise<{ ok: boolean }>;
  updateConfig: (patch: Record<string, unknown>) => Promise<unknown>;
}

/**
 * 构造宿主 + 控制器。
 * @param mode 初始聊天模式
 * @returns 宿主状态、控制器、api 桩、toast 文案
 */
function makeController(mode: 'queue' | 'steer') {
  const toasts: string[] = [];
  const state: Record<string, unknown> = {
    events: [],
    currentThreadId: 't1',
    sessions: [],
    streamText: '',
    finalizedStreamText: '',
    busy: false,
    activeTool: null,
    liveInputs: [],
    toolResults: {},
    composerSeed: null,
    chatMode: mode,
    queuedMessages: [],
    queuePaused: false,
  };
  const host = {
    patches: [] as unknown[],
    patch(action: unknown) {
      const next =
        typeof action === 'function'
          ? (action as (prev: Record<string, unknown>) => Record<string, unknown>)(state)
          : (action as Record<string, unknown>);
      host.patches.push(next);
      Object.assign(state, next);
    },
    getState: () => state,
  };
  const api: ApiStub = {
    runCalls: [],
    interjectCalls: [],
    configCalls: [],
    async runTurn(params) {
      api.runCalls.push(params);
      return { threadId: 't1' };
    },
    async interjectTurn(params) {
      api.interjectCalls.push(params);
      return { ok: true, action: 'steered' };
    },
    async steerTurn() {
      return { ok: true };
    },
    async abortTurn() {
      return { ok: true };
    },
    async updateConfig(patch) {
      api.configCalls.push(patch);
      return { ok: true };
    },
  };
  const services = {
    api,
    toast: (message: string) => {
      toasts.push(message);
    },
    reducers: { appendFinalText: (events: unknown) => events },
    navigate: () => {},
    stream: {},
    toastSvc: {},
    dialogSvc: {},
  };
  const sessions = {
    async refreshSessions() {},
    streamPhase() {},
    viewAttachment: { attach: () => 0, epoch: () => 0, detached: false },
    modes: { flush: async () => {} },
  };
  const ctrl = new ComposerController(
    host as unknown as AppHost,
    services as unknown as AppServices,
    sessions as unknown as SessionController,
  );
  return { state, ctrl, api, toasts, host };
}

test('队列模式：回合中发送只入队，收尾后按 FIFO 依次发送（含附件）', async () => {
  const { state, ctrl, api, toasts } = makeController('queue');
  const gates = [deferred<TurnRunResult>(), deferred<TurnRunResult>()];
  let call = 0;
  api.runTurn = (params) => {
    api.runCalls.push(params);
    return gates[call++]!.promise;
  };

  const first = ctrl.send('任务一', [], []);
  await flush();
  assert.strictEqual(api.runCalls.length, 1);

  // 回合进行中发第二条：不得立刻跑第二个回合，只能入队。
  await ctrl.send('任务二', [{ mediaType: 'image/png', data: 'AAAA' }], [
    { name: 'spec.md', mediaType: 'text/markdown', data: 'BBBB' },
  ]);
  assert.strictEqual(api.runCalls.length, 1, '在飞时不得起第二个回合');
  assert.strictEqual((state.queuedMessages as unknown[]).length, 1, '第二条应进入队列');
  assert.ok(
    toasts.some((m) => m.includes('已加入队列')),
    `应有入队提示，实际: ${toasts.join(' | ')}`,
  );

  gates[0]!.resolve({ threadId: 't1' });
  await first;
  await flush();
  assert.strictEqual(api.runCalls.length, 2, '收尾后必须自动续发第二条');
  const second = api.runCalls[1]!;
  assert.strictEqual(second['prompt'], '任务二');
  assert.deepStrictEqual(second['images'], [{ mediaType: 'image/png', data: 'AAAA' }]);
  assert.deepStrictEqual(second['files'], [
    { name: 'spec.md', mediaType: 'text/markdown', data: 'BBBB' },
  ]);
  assert.strictEqual((state.queuedMessages as unknown[]).length, 0, '取出后队列应清空');

  gates[1]!.resolve({ threadId: 't1' });
  await flush();
});

test('「停止」暂停队列：回合收尾后不自动续发，resume 才继续', async () => {
  const { state, ctrl, api } = makeController('queue');
  const gate = deferred<TurnRunResult>();
  api.runTurn = (params) => {
    api.runCalls.push(params);
    return gate.promise;
  };

  const first = ctrl.send('任务一', [], []);
  await flush();
  await ctrl.send('任务二', [], []);
  ctrl.stop();
  assert.strictEqual(state.queuePaused, true, '停止必须暂停队列');

  gate.reject(new Error('已取消（用户中断）'));
  await first;
  await flush();
  assert.strictEqual(api.runCalls.length, 1, '暂停后不得自动续发');
  assert.strictEqual((state.queuedMessages as unknown[]).length, 1, '暂停不等于丢消息');

  ctrl.chatQueue.resume();
  await flush();
  assert.strictEqual(api.runCalls.length, 2, '继续后必须接着发');
  assert.strictEqual(api.runCalls[1]?.['prompt'], '任务二');
});

test('插话模式 · 相关：走 turns.interject 并入当前回合，附件一起送，不入队', async () => {
  const { state, ctrl, api, toasts } = makeController('steer');
  const gate = deferred<TurnRunResult>();
  api.runTurn = (params) => {
    api.runCalls.push(params);
    return gate.promise;
  };

  const first = ctrl.send('重构设置页', [], []);
  await flush();
  await ctrl.send(
    '补充一下，还要处理空输入',
    [{ mediaType: 'image/gif', data: 'GGGG' }],
    [{ name: 'demo.mp4', mediaType: 'video/mp4', data: 'VVVV' }],
  );
  assert.strictEqual(api.interjectCalls.length, 1, '插话模式必须走 turns.interject');
  const params = api.interjectCalls[0]!;
  assert.strictEqual(params['prompt'], '补充一下，还要处理空输入');
  assert.deepStrictEqual(params['images'], [{ mediaType: 'image/gif', data: 'GGGG' }]);
  assert.deepStrictEqual(params['files'], [
    { name: 'demo.mp4', mediaType: 'video/mp4', data: 'VVVV' },
  ]);
  assert.strictEqual((state.queuedMessages as unknown[]).length, 0, '相关插话不入队');
  assert.ok(toasts.some((m) => m.includes('已并入当前任务')));
  gate.resolve({ threadId: 't1' });
  await first;
});

test('插话模式 · 无关：服务端判定 interrupted 后，本条内容成为新任务并保住附件', async () => {
  const { state, ctrl, api, toasts } = makeController('steer');
  const gate = deferred<TurnRunResult>();
  api.runTurn = (params) => {
    api.runCalls.push(params);
    return api.runCalls.length === 1 ? gate.promise : Promise.resolve({ threadId: 't1' });
  };
  api.interjectTurn = async (params) => {
    api.interjectCalls.push(params);
    return { ok: true, action: 'interrupted', reason: 'interrupt-marker' };
  };

  const first = ctrl.send('重构设置页', [], []);
  await flush();
  await ctrl.send('算了，改做登录页', [{ mediaType: 'image/png', data: 'XXXX' }], []);
  assert.strictEqual((state.queuedMessages as unknown[]).length, 1, '无关内容应插队等待新回合');

  gate.reject(new Error('已取消（用户中断）'));
  await first;
  await flush();
  assert.strictEqual(api.runCalls.length, 2, '中断后必须立刻转入新任务');
  assert.strictEqual(api.runCalls[1]?.['prompt'], '算了，改做登录页');
  assert.deepStrictEqual(api.runCalls[1]?.['images'], [{ mediaType: 'image/png', data: 'XXXX' }]);
  const notes = (state.events as { type: string; payload?: { content?: string } }[])
    .filter((e) => e.type === 'system')
    .map((e) => String(e.payload?.content ?? ''));
  assert.ok(notes.some((n) => n.includes('已中止')), '中断应写一条系统提示');
  assert.ok(
    !toasts.some((m) => m.startsWith('运行失败')),
    `中断不得报成运行失败，实际: ${toasts.join(' | ')}`,
  );
  assert.ok(toasts.some((m) => m.includes('检测到新任务')));
});

test('聊天模式切换：写状态并落盘到用户级配置', () => {
  const { state, ctrl, api } = makeController('queue');
  ctrl.chatQueue.setMode('steer');
  assert.strictEqual(state.chatMode, 'steer');
  assert.deepStrictEqual(api.configCalls, [{ chatMode: 'steer' }]);
});
