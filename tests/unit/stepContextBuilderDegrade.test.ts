/**
 * P5 自动降档：StepContextBuilder.repo-map 消费点行为单测。
 *
 * 验证降级信号触发时 repo-map 强制纯 BM25（忽略语义嵌入）并**收缩载荷大纲档位**，未触发时保持既有口径：
 *  - 信号关 + 有 embedding ⇒ 走混合检索（HybridRepoMapContext），opts 默认；
 *  - 信号关 + 无 embedding ⇒ 纯 BM25（RepoMapContext），opts 默认；
 *  - 信号关（budgetDegrade 缺省 undefined）⇒ 等同信号关；
 *  - 信号开 + 有/无 embedding ⇒ 强制纯 BM25、`payloadShape:'degrade'`、关 rerank，且**绝不走混合路**。
 *
 * 口径变更留档（2026-09-17，D7）：降档**原先缩「文件数」`fileK 10→5`**，现已改为缩「大纲档位」
 * （`DEGRADE_PLAN`：只留 Top-1 完整符号大纲，其余命中文件降为一行路径）。
 * 原口径为什么错：梯度投送（`RepoMapPayload`）下 token 大头是**前几档的完整大纲**，文件数从 5 放到 10
 * 只差约 34 token，却让命中率掉了 12.1pp（实测 51.5%→39.4%）——即在几乎不省钱的地方砍掉了质量。
 * 新口径同档位下 946 token（旧降档 1337，−29%）且命中率 69.7%（旧降档 36.4%，+33.3pp）。
 * 因此**不再有 `fileK` 收缩行为**，断言相应改为检查 `payloadShape`。
 *
 * 通过 mock 引擎记录调用（root/q/opts）做断言，不依赖真实索引/嵌入实现。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StepContextBuilder } from '../../src/core/stepContextBuilder.js';
import type { RepoMapContextEngine } from '../../src/context/repoMapContextEngine.js';
import type { StepRunnerDeps } from '../../src/core/stepTypes.js';
import type { BudgetDegradeSignal } from '../../src/ports/model/budgetDegrade.js';
import type { EmbeddingPort } from '../../src/ports/model/embedding.js';

/** 一次 repo-map 调用的观测记录。 */
interface Call {
  root: string;
  q: string;
  opts: Record<string, unknown>;
}

/** 构造记录调用参数的 mock 引擎（纯 BM25 同步 / 混合异步，均返回非空串以注入系统消息）。 */
const makeEngine = (calls: Call[]): RepoMapContextEngine => {
  const engine = {
    getRepoMapContext(root: string, q: string, opts: Record<string, unknown> = {}): string {
      calls.push({ root, q, opts });
      return '# Repo Map';
    },
    getHybridRepoMapContext(
      root: string,
      q: string,
      _emb: EmbeddingPort,
      opts: Record<string, unknown> = {},
    ): Promise<string> {
      calls.push({ root, q, opts });
      return Promise.resolve('# Hybrid Repo Map');
    },
  };
  return engine as unknown as RepoMapContextEngine;
};

/** 一个会置位的降级信号。 */
const onSignal = (): BudgetDegradeSignal => ({
  get shouldDegrade() {
    return true;
  },
});

/** 一个恒不降级的降级信号（显式 false，区别于缺省 undefined）。 */
const offSignal = (): BudgetDegradeSignal => ({
  get shouldDegrade() {
    return false;
  },
});

/** 取唯一一次调用并断言存在（noUncheckedIndexedAccess 下需收窄）。 */
const onlyCall = (calls: Call[]): Call => {
  assert.strictEqual(calls.length, 1, '应恰好一次 repo-map 调用');
  const call = calls[0];
  assert.ok(call, '调用记录不应为空');
  return call;
};

/** 不可达的语义嵌入端口（仅用于「有 embedding」分支的占位，降级时应被忽略）。 */
const embedding = {} as unknown as EmbeddingPort;

/** 构造最小可跑的 StepRunnerDeps（只填 buildMessages 实际读取的字段）。 */
const makeDeps = (over: Partial<StepRunnerDeps>): StepRunnerDeps => {
  const events = [{ type: 'user', payload: { content: 'fix the parser bug in src/parser.ts' } }];
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

test('P5 消费点：信号关 + 有 embedding ⇒ 走混合检索（Hybrid），opts 默认', async () => {
  const calls: Call[] = [];
  const deps = makeDeps({
    repoMapContext: makeEngine(calls),
    embedding,
    budgetDegrade: offSignal(),
  });
  await new StepContextBuilder(deps).buildMessages();
  const call = onlyCall(calls);
  assert.strictEqual(call.opts.fileK, undefined, '未降级应保持默认 fileK');
});

test('P5 消费点：信号关 + 无 embedding ⇒ 纯 BM25，opts 默认（fileK=10）', async () => {
  const calls: Call[] = [];
  const deps = makeDeps({
    repoMapContext: makeEngine(calls),
    embedding: undefined,
    budgetDegrade: offSignal(),
  });
  await new StepContextBuilder(deps).buildMessages();
  const call = onlyCall(calls);
  assert.strictEqual(call.opts.fileK, undefined, '未降级保持默认 fileK');
});

test('P5 消费点：budgetDegrade 缺省 undefined ⇒ 等同信号关（零行为变更）', async () => {
  const calls: Call[] = [];
  const deps = makeDeps({ repoMapContext: makeEngine(calls), embedding, budgetDegrade: undefined });
  await new StepContextBuilder(deps).buildMessages();
  const call = onlyCall(calls);
  assert.strictEqual(call.opts.fileK, undefined);
});

test('P5 消费点：信号开 + 有 embedding ⇒ 强制纯 BM25、payloadShape=degrade、关 rerank、不走混合', async () => {
  const calls: Call[] = [];
  const deps = makeDeps({
    repoMapContext: makeEngine(calls),
    embedding,
    budgetDegrade: onSignal(),
  });
  await new StepContextBuilder(deps).buildMessages();
  const call = onlyCall(calls);
  assert.strictEqual(call.opts.payloadShape, 'degrade', '降级应把载荷收缩到应急大纲档位');
  assert.strictEqual(call.opts.rerank, false, '降级应关闭第二段词法重排');
  assert.strictEqual(call.opts.fileK, undefined, '降级**不再**缩文件数（原口径已废止）');
});

test('P5 消费点：信号开 + 无 embedding ⇒ 纯 BM25、payloadShape=degrade（与混合分支结果一致）', async () => {
  const calls: Call[] = [];
  const deps = makeDeps({
    repoMapContext: makeEngine(calls),
    embedding: undefined,
    budgetDegrade: onSignal(),
  });
  await new StepContextBuilder(deps).buildMessages();
  const call = onlyCall(calls);
  assert.strictEqual(call.opts.payloadShape, 'degrade');
  assert.strictEqual(call.opts.rerank, false);
  assert.strictEqual(call.opts.fileK, undefined);
});
