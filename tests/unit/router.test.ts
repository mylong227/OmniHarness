import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ModelRouter } from '../../src/adapters/model/modelRouter.ts';
import { ConfigError } from '../../src/config/configError.ts';
import type { ModelOutput, ModelPort, ModelRequest } from '../../src/ports/model/model.ts';

/** 始终成功的模型，记录调用次数与 name。 */
class OkModel implements ModelPort {
  public readonly name: string;
  public calls = 0;
  public constructor(name: string) {
    this.name = name;
  }
  public async generate(_request: ModelRequest): Promise<ModelOutput> {
    this.calls += 1;
    return { text: `ok:${this.name}` };
  }
}

/** 始终抛错的模型（模拟 5xx / 网络 / 超时）。 */
class FailModel implements ModelPort {
  public readonly name = 'fail';
  public async generate(): Promise<ModelOutput> {
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

test('by-role：按角色映射选模型；未映射回退首项；映射到未知模型 fail-closed', async () => {
  const executor = new OkModel('executor-model');
  const reviewer = new OkModel('reviewer-model');
  const router = new ModelRouter({
    strategy: 'by-role',
    roles: { executor: 'executor-model', reviewer: 'reviewer-model' },
    entries: [
      { adapter: executor, model: 'executor-model' },
      { adapter: reviewer, model: 'reviewer-model' },
    ],
  });
  const reviewed = await router.generate({ ...REQ, role: 'reviewer' });
  assert.strictEqual(reviewed.text, 'ok:reviewer-model');
  assert.strictEqual(reviewer.calls, 1);
  assert.strictEqual(executor.calls, 0);
  assert.match(router.routeReason, /by-role role=reviewer/u);

  const fallback = await router.generate({ ...REQ, role: 'compactor' });
  assert.strictEqual(fallback.text, 'ok:executor-model');
  assert.strictEqual(executor.calls, 1);

  const broken = new ModelRouter({
    strategy: 'by-role',
    roles: { reviewer: 'missing-model' },
    entries: [{ adapter: executor, model: 'executor-model' }],
  });
  await assert.rejects(
    () => broken.generate({ ...REQ, role: 'reviewer' }),
    /映射到未知模型 "missing-model"/u,
  );
});

test('ucb1：按成功/延迟自适应，失败臂不会被一直选中', async () => {
  const good = new OkModel('good');
  const fail = new FailModel();
  const router = new ModelRouter({
    strategy: 'ucb1',
    entries: [
      { adapter: fail, model: 'fail' },
      { adapter: good, model: 'good' },
    ],
  });
  for (let i = 0; i < 12; i += 1) {
    try {
      await router.generate(REQ);
    } catch {
      // 失败是预期输入；UCB1 记录 0 奖励后继续。
    }
  }
  assert.ok(good.calls > 0);
  assert.match(router.routeReason, /ucb1 chosen=/u);
  assert.ok(
    router.routeReason.includes('good') || router.routeReason.includes('fail'),
    '路由理由必须点名被选中的模型',
  );
});

test('配置校验：modelRouter.roles 必须是「角色 → 非空模型名」对象', () => {
  assert.doesNotThrow(() =>
    ConfigError.validateModelRouter({
      modelRouter: {
        strategy: 'by-role',
        entries: [{ model: 'm' }],
        roles: { reviewer: 'm' },
      },
    }),
  );
  assert.throws(
    () =>
      ConfigError.validateModelRouter({
        modelRouter: {
          strategy: 'by-role',
          entries: [{ model: 'm' }],
          roles: { reviewer: '' },
        },
      }),
    /roles\["reviewer"\] 必须是非空字符串/u,
  );
});
