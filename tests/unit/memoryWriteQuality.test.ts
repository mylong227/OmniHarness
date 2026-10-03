/**
 * **记忆写入质量**判据（G9/M2，2026-10-03 第二十一轮）。
 *
 * ## 它修的是什么
 *
 * 原实现只有"标点/大小写归一化后的**精确**匹配"去重，于是两类缺陷同时存在：
 *  1. **改写即新增**：同一件事换个说法再抽到一次，就多一条（primer 只有 5 个名额 ⇒ 重复事实挤掉别的）；
 *  2. **旧事实无法替代**：被后续结论推翻的事实（`policy` → `restricted`）会与新事实**并存**，
 *     于是回灌时同时给出互相矛盾的两条。
 *
 * 现按**骨架（非 ASCII 字符集）+ 值位（ASCII 词元）**三态判定：`duplicate` 不新增 / `supersede`
 * 新事实入库且旧事实置 `expiresAt` 失效（**不删除**，历史仍可查）/ `distinct` 两条都留。
 *
 * ## 判据（含反例，防"为了去重而丢信息"）
 *
 * | # | 判据 |
 * | --- | --- |
 * | ① | 语序/虚词改写注入 2 次 ⇒ **可召回事实只 +1**（报告 M2 的原话判据） |
 * | ② | 值位冲突（`policy` → `restricted`）⇒ 新事实可召回、**旧事实失效但仍留存**（不删除） |
 * | ③ | **反例（防误并）**：两条不相关事实必须都保留 |
 * | ④ | 值位冲突的第二种形态：`pnpm` → `npm`（另一条骨架相同、值不同） |
 * | ⑤ | 纯英文事实（骨架为空）不臆断冲突：值不同则**都留** |
 * | ⑥ | 与 M3 交互：`includeToolOutput` 档下新事实仍标 `untrusted`，去重/替代不改变信任标注 |
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryExtractor } from '../../src/adapters/memory/memoryExtractor.js';
import type { ModelPort } from '../../src/ports/model/model.js';
import type { SessionEvent } from '../../src/ports/runtime/event.js';
import type { LongTermMemoryPort, MemoryFact } from '../../src/ports/memory/longTermMemory.js';

/**
 * 内存版长期记忆桩（与既有记忆测试同款）。
 * @returns 仅存于进程内的长期记忆端口。
 */
function stubStore(): LongTermMemoryPort {
  const facts: MemoryFact[] = [];
  return {
    name: 'stub',
    remember: (fact) => facts.push(fact),
    recall: (query, k) => facts.filter((f) => f.text.includes(query)).slice(0, k),
    all: () => facts,
    get: (id) => facts.find((f) => f.id === id),
    update: (id, patch) => {
      const i = facts.findIndex((f) => f.id === id);
      if (i === -1) return false;
      facts[i] = { ...facts[i]!, ...patch };
      return true;
    },
    delete: (id) => {
      const i = facts.findIndex((f) => f.id === id);
      if (i === -1) return false;
      facts.splice(i, 1);
      return true;
    },
    get count() {
      return facts.length;
    },
  };
}

/**
 * 桩模型：第 n 次调用返回第 n 组事实（越界后重复最后一组）。
 * @param batches 每次 `generate` 返回的 JSON 字符串数组。
 * @returns 模型端口。
 */
function scriptedModel(batches: readonly string[][]): ModelPort {
  let call = 0;
  return {
    name: 'scripted',
    generate: async () => {
      const batch = batches[Math.min(call, batches.length - 1)] ?? [];
      call += 1;
      return { text: JSON.stringify(batch) };
    },
  } as unknown as ModelPort;
}

/**
 * 造一条 user 事件。
 * @param content 文本。
 * @returns 会话事件。
 */
function userEvent(content: string): SessionEvent {
  return {
    id: `u-${content.slice(0, 8)}`,
    type: 'user',
    sessionId: 's1',
    timestamp: new Date(0).toISOString(),
    payload: { content },
  } as SessionEvent;
}

/**
 * 可召回事实（未失效的那些）——primer 的真实输入面。
 * @param store 记忆端口。
 * @param nowMs 判定时刻。
 * @returns 未失效事实。
 */
function liveFacts(store: LongTermMemoryPort, nowMs: number): readonly MemoryFact[] {
  return store.all().filter((f) => f.expiresAt === undefined || Date.parse(f.expiresAt) > nowMs);
}

test('① 语序/虚词改写注入 2 次 ⇒ 可召回事实只 +1（报告 M2 的原话判据）', async () => {
  const store = stubStore();
  const extractor = new MemoryExtractor(
    scriptedModel([
      ['项目用 pnpm 管理依赖'],
      ['项目的依赖用 pnpm 管理'], // 同一件事的改写：语序 + 虚词
    ]),
    store,
  );
  const first = await extractor.consolidate([userEvent('回合一')], 's1');
  const second = await extractor.consolidate([userEvent('回合一'), userEvent('回合二')], 's1');
  assert.strictEqual(first, 1);
  assert.strictEqual(second, 0, '改写版不该新增（否则重复事实会挤掉 primer 的名额）');
  assert.strictEqual(store.count, 1);
});

test('② 值位冲突（policy → restricted）⇒ 新的可召回、旧的失效但**仍留存**', async () => {
  const store = stubStore();
  const extractor = new MemoryExtractor(
    scriptedModel([['沙箱默认档是 policy'], ['沙箱默认档是 restricted']]),
    store,
  );
  await extractor.consolidate([userEvent('回合一')], 's1');
  const now = Date.now();
  await extractor.consolidate([userEvent('回合一'), userEvent('回合二')], 's1');

  assert.strictEqual(
    store.count,
    2,
    '旧事实必须**留存**（不删除）：记忆的失败方向偏向留下多余事实',
  );
  const live = liveFacts(store, now);
  assert.strictEqual(live.length, 1, '同一骨架下只应有一条可召回事实');
  assert.strictEqual(live[0]!.text, '沙箱默认档是 restricted', '可召回的应是**后写**的结论');
  const old = store.all().find((f) => f.text === '沙箱默认档是 policy');
  assert.ok(old !== undefined, '旧事实仍在 all() 里（历史可查）');
  assert.ok(
    old.expiresAt !== undefined && Date.parse(old.expiresAt) <= Date.now(),
    '旧事实必须以 expiresAt 失效（fail-closed：recall 不再召回，但不删除）',
  );
});

test('③ 反例（防误并）：两条不相关事实都必须保留', async () => {
  const store = stubStore();
  const extractor = new MemoryExtractor(
    scriptedModel([['沙箱默认档是 policy'], ['构建用 pnpm 而不是 npm']]),
    store,
  );
  await extractor.consolidate([userEvent('回合一')], 's1');
  await extractor.consolidate([userEvent('回合一'), userEvent('回合二')], 's1');
  assert.strictEqual(store.count, 2, '不相关事实被并掉 = 静默丢信息（本仓最忌讳的形态）');
  assert.strictEqual(liveFacts(store, Date.now()).length, 2);
});

test('④ 值位冲突第二种形态：pnpm → npm（骨架相同、值不同）', async () => {
  const store = stubStore();
  const extractor = new MemoryExtractor(
    scriptedModel([['包管理器用 pnpm'], ['包管理器用 npm']]),
    store,
  );
  await extractor.consolidate([userEvent('回合一')], 's1');
  await extractor.consolidate([userEvent('回合一'), userEvent('回合二')], 's1');
  const live = liveFacts(store, Date.now());
  assert.strictEqual(live.length, 1);
  assert.strictEqual(live[0]!.text, '包管理器用 npm');
});

test('⑤ 纯英文事实（骨架为空）不臆断冲突：值不同则都留', async () => {
  const store = stubStore();
  const extractor = new MemoryExtractor(scriptedModel([['prefer pnpm'], ['prefer npm']]), store);
  await extractor.consolidate([userEvent('回合一')], 's1');
  await extractor.consolidate([userEvent('回合一'), userEvent('回合二')], 's1');
  assert.strictEqual(
    store.count,
    2,
    '骨架为空时无从判断是否同一件事 ⇒ 必须并存（保守方向：宁可留噪声，不可丢信息）',
  );
});

test('⑥ 与 M3 交互：工具输出档下的新事实仍标 untrusted，替代不改变信任标注', async () => {
  const store = stubStore();
  const extractor = new MemoryExtractor(
    scriptedModel([['沙箱默认档是 policy'], ['沙箱默认档是 restricted']]),
    store,
    { includeToolOutput: true },
  );
  const toolEvent = {
    id: 't-1',
    type: 'tool_result',
    sessionId: 's1',
    timestamp: new Date(0).toISOString(),
    payload: { callId: 'c1', ok: true, output: '沙箱默认档是 policy' },
  } as SessionEvent;
  await extractor.consolidate([toolEvent], 's1');
  await extractor.consolidate(
    [toolEvent, { ...toolEvent, id: 't-2', payload: { callId: 'c2', ok: true, output: 'x' } }],
    's1',
  );
  const live = liveFacts(store, Date.now());
  assert.strictEqual(live.length, 1, '值位冲突应已替代');
  assert.strictEqual(
    live[0]!.trust,
    'untrusted',
    '信任标注必须随新事实继续成立（M3 的投毒闸不因 M2 的替代被绕过）',
  );
});
