/**
 * P_prefix：前缀稳定性治理——repo-map 动态段位置单测。
 *
 * 验证治理后的消息排序（前缀缓存友好）：
 *   `world_state` → 常驻指令（静态头锚点）→ 事件历史 → **repo-map（尾部动态段）**。
 * 核心不变量：跨回合稳定的「world_state + 指令 + 事件历史」构成前缀缓存锚点，
 * 仅尾部 repo-map 每轮随查询变化；repo-map 必须位于所有事件之后（而非之前）。
 *
 * 通过 mock 引擎返回哨兵串、检查 buildMessages 产出消息的 role/位置做断言，
 * 不依赖真实索引/嵌入/文件系统。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StepContextBuilder } from '../../src/core/stepContextBuilder.ts';
import { PrefixStability } from '../../src/context/prefixStability.ts';
import { CacheMissAttributionAnalyst } from '../../src/observability/cacheMissAttributionAnalyst.ts';
import type { RepoMapContextEngine } from '../../src/context/repoMap/repoMapContextEngine.ts';
import type { StepRunnerDeps } from '../../src/core/stepTypes.ts';
import type { ModelMessage } from '../../src/ports/model/model.ts';

/** repo-map 注入内容哨兵（用于定位其在消息列表中的下标）。 */
const REPOMAP_SENTINEL = '# REPOMAP_TAIL_SENTINEL';

/** 一次 repo-map 调用的观测记录。 */
interface Call {
  root: string;
  q: string;
  opts: Record<string, unknown>;
}

/** 构造记录调用参数并返回哨兵串的 mock 引擎（纯 BM25 同步 / 混合异步）。 */
const makeEngine = (calls: Call[]): RepoMapContextEngine =>
  ({
    getRepoMapContext(root: string, q: string, opts: Record<string, unknown> = {}): string {
      calls.push({ root, q, opts });
      return REPOMAP_SENTINEL;
    },
    getHybridRepoMapContext(
      root: string,
      q: string,
      _emb: unknown,
      opts: Record<string, unknown> = {},
    ): Promise<string> {
      calls.push({ root, q, opts });
      return Promise.resolve(REPOMAP_SENTINEL);
    },
  }) as unknown as RepoMapContextEngine;

/** 构造最小可跑的 StepRunnerDeps（多事件种子，便于断言「事件在 repo-map 之前」）。 */
const makeDeps = (over: Record<string, unknown>): StepRunnerDeps => {
  const events = [
    { type: 'user', payload: { content: 'fix the parser bug in src/parser.ts' } },
    { type: 'assistant', payload: { content: 'on it' } },
    { type: 'user', payload: { content: 'also check src/lexer.ts' } },
  ];
  const base = {
    model: {},
    tools: {},
    approvals: {},
    sandbox: {},
    sessionId: 's',
    recorder: { allEvents: () => events, system: () => undefined },
    workspaceRoot: '/ws',
    repoMapEnabled: true,
    repoMapContext: {} as RepoMapContextEngine,
    fragments: [],
  };
  return { ...base, ...over } as unknown as StepRunnerDeps;
};

/** 返回指定 role 最后一次出现的下标（用于定位尾部动态段）。 */
const lastIndexOfRole = (msgs: readonly ModelMessage[], role: string): number => {
  let idx = -1;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m !== undefined && m.role === role) {
      idx = i;
    }
  }
  return idx;
};

/** 取指定下标的消息并断言非 undefined（noUncheckedIndexedAccess 收窄）。 */
const messageAt = (msgs: readonly ModelMessage[], idx: number): ModelMessage => {
  const m = msgs[idx];
  assert.ok(m !== undefined, `消息下标 ${idx} 不应为空`);
  return m;
};

test('P_prefix：repo-map 置于消息尾部（事件历史之后）', async () => {
  const calls: Call[] = [];
  const msgs = await new StepContextBuilder(
    makeDeps({ repoMapContext: makeEngine(calls), projectInstructionsEnabled: false }),
  ).buildMessages();
  // 3 条事件 + 1 条尾部 repo-map system 消息。
  assert.strictEqual(msgs.length, 4, '应为 3 事件 + 1 尾部 repo-map');
  const repoIdx = lastIndexOfRole(msgs, 'system');
  assert.strictEqual(repoIdx, msgs.length - 1, 'repo-map system 消息应在最末（尾部动态段）');
  assert.strictEqual(
    messageAt(msgs, repoIdx).content,
    REPOMAP_SENTINEL,
    '尾部 system 应为 repo-map 内容',
  );
  const lastUser = lastIndexOfRole(msgs, 'user');
  assert.ok(lastUser >= 0 && lastUser < repoIdx, '所有 user 事件应位于 repo-map 之前');
});

test('P_prefix：repo-map 关闭（repoMapEnabled=false）⇒ 不注入任何 repo-map', async () => {
  const calls: Call[] = [];
  const msgs = await new StepContextBuilder(
    makeDeps({
      repoMapContext: makeEngine(calls),
      repoMapEnabled: false,
      projectInstructionsEnabled: false,
    }),
  ).buildMessages();
  assert.strictEqual(calls.length, 0, '关闭时不应调用 repo-map 引擎');
  assert.strictEqual(msgs.length, 3, '仅 3 条事件，无 repo-map');
  assert.ok(!msgs.some((m) => m.content === REPOMAP_SENTINEL), '消息中不应出现 repo-map 内容');
});

test('P_prefix：含 compactor 时 repo-map 仍位于尾部（压缩不影响动态段位置）', async () => {
  const calls: Call[] = [];
  // 极简 compactor：原样透传消息（不折叠），仅验证 repo-map 尾部位置在压缩路径下保持。
  const compactor = {
    compact: async (m: ModelMessage[]) => ({ messages: m, compacted: false }),
  };
  const msgs = await new StepContextBuilder(
    makeDeps({ repoMapContext: makeEngine(calls), projectInstructionsEnabled: false, compactor }),
  ).buildMessages();
  const repoIdx = lastIndexOfRole(msgs, 'system');
  assert.strictEqual(repoIdx, msgs.length - 1, 'compactor 路径下 repo-map 仍应在尾部');
  assert.strictEqual(messageAt(msgs, repoIdx).content, REPOMAP_SENTINEL);
  const lastUser = lastIndexOfRole(msgs, 'user');
  assert.ok(lastUser < repoIdx, '事件仍位于 repo-map 之前');
});

test('P_prefix：首个 user 事件必须位于 repo-map（尾部）之前', async () => {
  const calls: Call[] = [];
  const msgs = await new StepContextBuilder(
    makeDeps({ repoMapContext: makeEngine(calls), projectInstructionsEnabled: false }),
  ).buildMessages();
  const firstUser = msgs.findIndex((m) => m.role === 'user');
  const repoIdx = lastIndexOfRole(msgs, 'system');
  assert.ok(firstUser >= 0, '应含 user 事件');
  assert.ok(firstUser < repoIdx, '首个 user 事件必须位于 repo-map（尾部）之前');
});

test('P_prefix：前缀复用率可读、与 PrefixStability 同口径（容量面板分因的信号来源）', async () => {
  const events: { type: string; payload: { content: string } }[] = [
    { type: 'user', payload: { content: 'fix the parser bug in src/parser.ts' } },
  ];
  const builder = new StepContextBuilder(
    makeDeps({
      repoMapEnabled: false,
      projectInstructionsEnabled: false,
      recorder: { allEvents: () => events, system: () => undefined },
    }),
  );
  await builder.buildMessages();
  assert.strictEqual(
    builder.prefixReuseRatioOfLastBuild,
    undefined,
    '首次请求没有可比基准 ⇒ 必须是 undefined；给 0 会被分因器读成"前缀被完全改写"',
  );
  const second = await builder.buildMessages();
  assert.strictEqual(builder.prefixReuseRatioOfLastBuild, 1, '同一输入两次组装 ⇒ 复用率恒为 1');

  // 改写**头部**（首条事件）⇒ 前缀从改动点起分叉，复用率必然落到分因器的下限之下。
  const head = events[0];
  assert.ok(head !== undefined);
  head.payload.content = '完全换一个任务：重写词法器';
  const third = await builder.buildMessages();
  const expected = Number(
    PrefixStability.prefixReuse(JSON.stringify(second), JSON.stringify(third)).toFixed(4),
  );
  assert.strictEqual(
    builder.prefixReuseRatioOfLastBuild,
    expected,
    '必须与 PrefixStability.prefixReuse 逐位一致（唯一实现；各写一份必然漂移）',
  );
  assert.ok(
    (builder.prefixReuseRatioOfLastBuild ?? 1) < CacheMissAttributionAnalyst.PREFIX_REUSE_FLOOR,
    '头部被改写必须让复用率低于下限 —— 否则面板永远报不出 prefix-rewrite',
  );
  assert.strictEqual(second.length, third.length, '（前提）消息条数不变，差异只来自首条内容');
});
