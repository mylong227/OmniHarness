import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { TemporalFactGraph } from '../../src/adapters/memory/temporalFactGraph.ts';
import type { MemoryFact } from '../../src/ports/memory/longTermMemory.ts';

// 固定时钟 / 日期（判据不读墙钟：`CODE_STANDARD` §12.1-5「可复现」）。
const T0 = Date.parse('2026-09-01T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

/** 毫秒 → ISO。 */
function at(ms: number): string {
  return new Date(ms).toISOString();
}

/** 构造一条记忆事实（默认创建于 T0）。 */
function fact(id: string, text: string, over: Partial<MemoryFact> = {}): MemoryFact {
  return {
    id,
    text,
    importance: 3,
    createdAt: at(T0),
    sessionId: 's1',
    source: 'tool',
    ...over,
  };
}

/** 卡 → `subject|predicate|object`（判据断言字面量用）。 */
function tripleOf(graph: TemporalFactGraph, factId: string): string | undefined {
  const card = graph.cardOf(factId);
  return card === undefined ? undefined : `${card.subject}|${card.predicate}|${card.object}`;
}

describe('TemporalFactGraph（P2-1 事实卡：抽取 / 归一化 / 时间有效性）', () => {
  it('抽取四种规则并归一化谓词（is / 冒号 / 动词 / 箭头）', () => {
    const graph = new TemporalFactGraph();
    graph.ingest(fact('copula', 'Build config is at old path'), T0);
    graph.ingest(fact('colon', 'Project: omniharness'), T0);
    graph.ingest(fact('verb', 'The user prefers vim'), T0);
    graph.ingest(fact('arrow', 'deploy -> staging'), T0);

    assert.deepStrictEqual(
      [
        tripleOf(graph, 'copula'),
        tripleOf(graph, 'colon'),
        tripleOf(graph, 'verb'),
        tripleOf(graph, 'arrow'),
      ],
      [
        'build config|is|at old path',
        'project|is|omniharness',
        'user|prefer|vim',
        'deploy|->|staging',
      ],
    );
    assert.strictEqual(graph.size(), 4);
  });

  it('实体归一化：小写 / 去冠词 / 去标点 / 折叠空白', () => {
    const graph = new TemporalFactGraph();
    graph.ingest(fact('norm', 'The  Build-Config: at  /old//path!'), T0);
    const card = graph.cardOf('norm');
    assert.ok(card !== undefined);
    assert.strictEqual(card.subject, 'build config');
    assert.strictEqual(card.object, 'at old path');
    assert.strictEqual(card.predicate, 'is');
  });

  it('同一 subject+predicate 的新事实把旧边 validTo 置为当前（时间有效性）', () => {
    const t1 = T0;
    const t2 = T0 + DAY;
    const graph = new TemporalFactGraph();
    graph.ingest(fact('old', 'service uses redis', { createdAt: at(t1) }), t1);
    graph.ingest(fact('new', 'service uses postgres', { createdAt: at(t2) }), t2);

    assert.strictEqual(graph.cardOf('old')?.validTo, t2, '旧边必须在 t2 关闭');
    assert.strictEqual(graph.cardOf('new')?.validTo, undefined, '新边仍有效');
    // 反例自证：谓词不同 ⇒ 不构成取代（不算「同一主谓」）。
    graph.ingest(fact('other', 'service requires postgres', { createdAt: at(t2 + DAY) }), t2 + DAY);
    assert.strictEqual(graph.cardOf('new')?.validTo, undefined, '不同谓词不得关闭同主语的边');
  });

  it('validTo 过滤：到点后旧边不再参与召回，新边仍可召回', () => {
    const t1 = T0;
    const t2 = T0 + DAY;
    const graph = new TemporalFactGraph();
    graph.ingest(fact('old', 'service uses redis', { createdAt: at(t1) }), t1);
    graph.ingest(fact('new', 'service uses postgres', { createdAt: at(t2) }), t2);

    const before = graph.recall('service', t1).map((hit) => hit.factId);
    const after = graph.recall('service', t2).map((hit) => hit.factId);
    assert.ok(before.includes('old'), '关闭前旧边可召回');
    assert.ok(!after.includes('old'), 'validTo 到点后旧边必须被过滤');
    assert.ok(after.includes('new'));
  });

  it('召回按 query token 与 s/p/o 重合度排序（主语+宾语全中者在前）', () => {
    const graph = new TemporalFactGraph();
    graph.ingest(fact('f1', 'cache uses redis'), T0);
    graph.ingest(fact('f2', 'session uses redis'), T0);

    const ids = graph.recall('cache redis', T0).map((hit) => hit.factId);
    assert.deepStrictEqual(ids, ['f1', 'f2']);
    assert.ok(
      (graph.recall('cache redis', T0)[0]?.score ?? 0) >
        (graph.recall('cache redis', T0)[1]?.score ?? 0),
      '主语重合必须体现为更高分',
    );
    // 同分裁决：factId 字典序（确定性，不依赖 locale / 插入序）。
    const tie = new TemporalFactGraph();
    tie.ingest(fact('b', 'cache uses redis'), T0);
    tie.ingest(fact('a', 'cache requires redis'), T0);
    assert.deepStrictEqual(
      tie.recall('cache redis', T0).map((hit) => hit.factId),
      ['a', 'b'],
    );
  });

  it('rebuild：从事实全量重建与增量 ingest 得到同一张图（进程重启路径）', () => {
    const t1 = T0;
    const t2 = T0 + DAY;
    const facts = [
      fact('old', 'service uses redis', { createdAt: at(t1) }),
      fact('new', 'service uses postgres', { createdAt: at(t2) }),
    ];
    const incremental = new TemporalFactGraph();
    for (const item of facts) {
      incremental.ingest(item, T0);
    }
    const rebuilt = new TemporalFactGraph();
    rebuilt.ingest(fact('stale', 'phantom is gone'), T0);
    rebuilt.rebuild(facts, T0);

    assert.strictEqual(rebuilt.size(), incremental.size());
    assert.strictEqual(rebuilt.cardOf('stale'), undefined, 'rebuild 必须清掉不在 facts 里的旧卡');
    assert.strictEqual(rebuilt.cardOf('old')?.validTo, incremental.cardOf('old')?.validTo);
    assert.deepStrictEqual(
      rebuilt.recall('service', t2).map((hit) => hit.factId),
      incremental.recall('service', t2).map((hit) => hit.factId),
    );
  });

  it('consolidate：合并同 s+p+o 重复边、关闭过期边、给出统计（不删事实）', () => {
    const t1 = T0 + DAY;
    const t2 = T0 + 2 * DAY;
    const graph = new TemporalFactGraph();
    // 乱序写入（后写入者的 createdAt 更早）⇒ 两条同 s+p+o 会同时处于活跃态，交给 consolidate 合并。
    graph.ingest(fact('n1', 'service is up', { createdAt: at(t1) }), t1);
    graph.ingest(fact('n2', 'service is up', { createdAt: at(T0) }), T0);
    graph.ingest(
      fact('exp', 'token is secret', {
        createdAt: at(T0),
        expiresAt: at(t1),
      }),
      T0,
    );
    assert.strictEqual(
      graph.activeSize(t2),
      2,
      '前置：exp 已按 expiresAt 失效，n1/n2 两条同 s+p+o 重复边仍活跃',
    );

    const report = graph.consolidate(t2);
    assert.deepStrictEqual(report, {
      before: 3,
      after: 1,
      merged: 1,
      expired: 1,
      pruned: 2,
      active: 1,
    });
    assert.ok(graph.cardOf('n1') !== undefined, '同 s+p+o 保留最新（validFrom 最大）');
    assert.strictEqual(graph.cardOf('n2'), undefined, '被合并的重复边关闭后被剪除');
    assert.strictEqual(graph.cardOf('exp'), undefined, '过期边关闭后被剪除');
    assert.strictEqual(graph.size(), 1);
  });

  it('consolidate(..., { keepClosed: true }) 保留关闭边但不再召回', () => {
    const t1 = T0 + DAY;
    const graph = new TemporalFactGraph();
    graph.ingest(fact('old', 'service uses redis', { createdAt: at(T0) }), T0);
    graph.ingest(fact('new', 'service uses postgres', { createdAt: at(t1) }), t1);

    const report = graph.consolidate(t1, { keepClosed: true });
    assert.strictEqual(report.pruned, 0);
    assert.strictEqual(report.after, 2, '保留模式不剪边');
    assert.strictEqual(report.active, 1, '关闭边不参与召回');
    assert.ok(graph.cardOf('old') !== undefined);
    assert.strictEqual(
      graph.cardOf('old')?.validTo,
      t1,
      '旧边在被取代时刻关闭（保留模式下仍可审计）',
    );
    assert.ok(!graph.recall('service', t1).some((hit) => hit.factId === 'old'));
  });

  it('无法解析不产生边（且不会留下旧卡）；remove / expiresAt 过滤可用', () => {
    const graph = new TemporalFactGraph();
    graph.ingest(fact('cn', '用户偏好暗色主题'), T0);
    graph.ingest(fact('empty', 'the path is '), T0);
    graph.ingest(fact('arrow-only', ' -> '), T0);
    assert.strictEqual(graph.size(), 0, '解析不出三元组时不得建边');
    assert.deepStrictEqual(graph.recall('用户偏好', T0), []);

    graph.ingest(fact('ok', 'alpha is beta'), T0);
    assert.strictEqual(graph.remove('ok'), true);
    assert.strictEqual(graph.remove('ok'), false);
    assert.strictEqual(graph.size(), 0);

    graph.ingest(fact('exp', 'alpha is beta', { expiresAt: at(T0 + DAY) }), T0);
    assert.ok(
      graph.recall('alpha', T0).some((hit) => hit.factId === 'exp'),
      '未到点应可召回',
    );
    assert.deepStrictEqual(graph.recall('alpha', T0 + DAY), [], 'expiresAt 到点必须过滤');
  });
});
