import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelRouter } from '../../src/adapters/model/router.js';
import type { ModelOutput, ModelPort, ModelRequest } from '../../src/ports/model.js';

/** 始终成功的模型，记录调用次数与 name。 */
class OkModel implements ModelPort {
  readonly name: string;
  calls = 0;
  constructor(name: string) {
    this.name = name;
  }
  async generate(_request: ModelRequest): Promise<ModelOutput> {
    this.calls += 1;
    return { text: `ok:${this.name}` };
  }
}

/** 始终抛错的模型（模拟 5xx / 网络 / 超时）。 */
class FailModel implements ModelPort {
  readonly name = 'fail';
  async generate(): Promise<ModelOutput> {
    throw new Error('5xx upstream');
  }
}

const REQ: ModelRequest = { messages: [{ role: 'user', content: 'hi' }], tools: [] };

test('health-fallback：首个 adapter 报错时自动用第二个并返回结果', async () => {
  const good = new OkModel('good');
  const router = new ModelRouter({
    strategy: 'health-fallback',
    entries: [
      { adapter: new FailModel(), model: 'fail' },
      { adapter: good, model: 'good' },
    ],
  });
  const out = await router.generate(REQ);
  assert.strictEqual(good.calls, 1);
  assert.strictEqual(out.text, 'ok:good');
});

test('health-fallback：全部失败则抛错（fail-closed）', async () => {
  const router = new ModelRouter({
    strategy: 'health-fallback',
    entries: [
      { adapter: new FailModel(), model: 'fail1' },
      { adapter: new FailModel(), model: 'fail2' },
    ],
  });
  await assert.rejects(() => router.generate(REQ));
});

test('least-cost：给不同 pricing，选累计成本更低者', async () => {
  const expensive = new OkModel('expensive');
  const cheap = new OkModel('cheap');
  const router = new ModelRouter({
    strategy: 'least-cost',
    entries: [
      { adapter: expensive, model: 'expensive', pricing: { inputPer1k: 100, outputPer1k: 100 } },
      { adapter: cheap, model: 'cheap', pricing: { inputPer1k: 1, outputPer1k: 1 } },
    ],
  });
  // 预先给昂贵的模型记一笔高额成本，使 cheap 成为累计成本最低者。
  router.recordUsage('expensive', 1000, 1000);
  const out = await router.generate(REQ);
  assert.strictEqual(cheap.calls, 1);
  assert.strictEqual(expensive.calls, 0);
  assert.strictEqual(out.text, 'ok:cheap');
});

test('by-task：含「写代码」的消息选 entries[0]，含「推理」选 entries[1]', async () => {
  const code = new OkModel('code');
  const reason = new OkModel('reason');
  const router = new ModelRouter({
    strategy: 'by-task',
    entries: [
      { adapter: code, model: 'code' },
      { adapter: reason, model: 'reason' },
    ],
  });
  const codeOut = await router.generate({
    messages: [{ role: 'user', content: '帮我写代码实现一个函数' }],
    tools: [],
  });
  assert.strictEqual(code.calls, 1);
  assert.strictEqual(codeOut.text, 'ok:code');

  const reasonOut = await router.generate({
    messages: [{ role: 'user', content: '请推理为什么系统会崩溃' }],
    tools: [],
  });
  assert.strictEqual(reason.calls, 1);
  assert.strictEqual(reasonOut.text, 'ok:reason');
});

test('round-robin：轮询选择 entries', async () => {
  const a = new OkModel('a');
  const b = new OkModel('b');
  const router = new ModelRouter({
    strategy: 'round-robin',
    entries: [
      { adapter: a, model: 'a' },
      { adapter: b, model: 'b' },
    ],
  });
  await router.generate(REQ);
  assert.strictEqual(a.calls, 1);
  assert.strictEqual(b.calls, 0);
  await router.generate(REQ);
  assert.strictEqual(a.calls, 1);
  assert.strictEqual(b.calls, 1);
});

test('fail-closed：entry 为空时构造即报错', () => {
  assert.throws(() => new ModelRouter({ strategy: 'round-robin', entries: [] }));
});
