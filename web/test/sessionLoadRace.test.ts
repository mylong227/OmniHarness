// 会话加载/切换的**竞态**判据（2026-10-28 前端审计两条高危）。
//
// ## 缺陷形态
//
// ① `loadThread` 没有请求代际护栏：快速连点两个会话时，先发的 `getThread` 可能后到，
//    无条件 `patch` 把视图与 hash 都写回**上一个**会话（`loadEarlier` 早有 currentThreadId
//    核对，`loadThread` 有多个 await 却漏了）。
// ② 点「新建」后旧回合仍在飞：`newSession()` 摘视图，但用户在新会话里一发送，
//    `ComposerController.send()` 会重新 `attach()`，护栏失效。旧会话的迟到事件先到就被
//    「认领」成当前会话，随后新会话自己的事件反而因 sid 不匹配被丢弃（串会话 + 新回合过程
//    事件丢失）。
//
// ## 判据
//
// ① 后发的加载先落地、先发的后到 ⇒ 状态必须停在后点的会话；
// ② 已被「新建」放弃的会话迟到事件不得被认领；同一时刻新会话的事件仍能被认领。
//
// 直跑（web 测试统一入口）：npm run web:test
import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AppHost, AppServices } from '../src/ui/controllers/AppController.ts';
import type { ThreadEvent } from '../src/types/models.ts';

const { SessionController } = await import('../src/ui/controllers/SessionController.ts');

/** 一条测试事件（ThreadEvent 的最小可用子集）。 */
interface TestEvent {
  id: string;
  type: string;
  payload?: Record<string, unknown>;
  sessionId?: string;
}

/** 最小状态形状（本判据实际读写的字段）。 */
interface TestState {
  currentThreadId: string | null;
  sessions: { id: string }[];
  events: TestEvent[];
  toolResults: Record<string, unknown>;
  liveInputs: unknown[];
  streamText: string;
  finalizedStreamText: string;
  busy: boolean;
  activeTool: string | null;
  historyHasMore: boolean;
  oldestEventId: string | null;
  historyLoading: boolean;
  sessionTick: number;
  [key: string]: unknown;
}

/** 可手动兑现的 Promise。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * 构造控制器环境：真 SessionController + 桩 host/api。
 * @param threadId 初始当前会话
 * @param sessionIds 侧栏在册会话（`ensure` 见到在册即跳过项目对齐）
 * @returns 控制器、状态、导航记录与按会话取的加载闸
 */
function makeEnv(threadId: string | null, sessionIds: string[]) {
  const gates = new Map<string, ReturnType<typeof deferred<{ items: TestEvent[]; hasMore: boolean }>>>();
  /** 按会话取（必要时创建）加载闸：先兑现后请求也成立（Promise 已决议）。 */
  const gateFor = (id: string) => {
    let gate = gates.get(id);
    if (gate === undefined) {
      gate = deferred<{ items: TestEvent[]; hasMore: boolean }>();
      gates.set(id, gate);
    }
    return gate;
  };
  const navigations: { threadId: string | null }[] = [];
  const state: TestState = {
    currentThreadId: threadId,
    sessions: sessionIds.map((id) => ({ id })),
    events: [],
    toolResults: {},
    liveInputs: [],
    streamText: '',
    finalizedStreamText: '',
    busy: false,
    activeTool: null,
    historyHasMore: false,
    oldestEventId: null,
    historyLoading: false,
    sessionTick: 0,
  };
  const host = {
    patch(action: Partial<TestState> | ((prev: TestState) => Partial<TestState>)) {
      Object.assign(state, typeof action === 'function' ? action(state) : action);
    },
    getState: () => state,
  };
  const services = {
    api: {
      // 每条加载各自一个闸：测试要精确控制「谁先落地」。
      getThread: (id: string) => gateFor(id).promise,
      listSessions: async () => ({ sessions: [] }),
      modesSet: async () => ({ ok: true }),
    },
    toast: () => {},
    navigate: (route: { threadId: string | null }) => navigations.push(route),
    reducers: {
      appendTextDelta: (text: string, delta: string) => text + delta,
      ingestEvent: (s: TestState, ev: TestEvent) => ({ events: [...s.events, ev] }),
      mergeToolResult: (prev: Record<string, unknown>) => prev,
    },
  };
  const ctrl = new SessionController(host as unknown as AppHost, services as unknown as AppServices);
  return { ctrl, state, gateFor, navigations };
}

test('① loadThread：先发的加载后到时必须丢弃（视图与 hash 停在后点的会话）', async () => {
  const { ctrl, state, gateFor, navigations } = makeEnv('t0', ['t1', 't2']);
  const first = ctrl.loadThread('t1');
  const second = ctrl.loadThread('t2');
  const secondEvent: TestEvent = { id: 'e2', type: 'assistant', payload: { content: 'B' } };
  gateFor('t2').resolve({ items: [secondEvent], hasMore: false });
  await second;
  // 先发的 t1 响应这才姗姗来迟（用户已经点了 t2）。
  gateFor('t1').resolve({ items: [{ id: 'e1', type: 'assistant' }], hasMore: false });
  await first;

  assert.strictEqual(state.currentThreadId, 't2', '陈旧响应不得把视图写回上一个会话');
  assert.deepStrictEqual(
    state.events.map((ev) => ev.id),
    ['e2'],
    '事件流必须仍是后点的会话',
  );
  assert.deepStrictEqual(
    navigations.map((route) => route.threadId),
    ['t2'],
    'hash 导航不得被陈旧响应改回 t1',
  );
});

test('② 新建会话后：被放弃会话的迟到事件不得被认领，新会话事件仍能认领', async () => {
  const { ctrl, state } = makeEnv('t1', ['t1', 't2']);
  ctrl.newSession();
  assert.strictEqual(state.currentThreadId, null);
  // 复现真实触发链：用户在新会话里发送 ⇒ ComposerController.send() 重新 attach（摘视图护栏失效）。
  ctrl.viewAttachment.attach();
  const late: TestEvent = { id: 'late-1', type: 'assistant', payload: { content: '旧回合收尾' }, sessionId: 't1' };
  // 事件载荷的 sessionId 不在 ThreadEvent 的静态类型里（老服务端兼容字段），测试按线上形态收窄。
  ctrl.handleEvent(late as unknown as ThreadEvent);
  assert.strictEqual(state.currentThreadId, null, '旧会话的迟到事件不得被认领成当前会话');
  assert.deepStrictEqual([...state.events], [], '迟到事件不得写进新视图');
  // 新会话自己的事件：仍必须被认领（否则容量面板 / Trace 拿不到会话）。
  ctrl.handleEvent({
    id: 'new-1',
    type: 'assistant',
    payload: { content: '新回合' },
    sessionId: 't2',
  } as unknown as ThreadEvent);
  assert.strictEqual(state.currentThreadId, 't2');
  assert.deepStrictEqual(
    state.events.map((ev) => ev.id),
    ['new-1'],
    '新会话事件必须正常进入视图',
  );
});
