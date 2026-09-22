/**
 * 检索评测查询集的结构与对抗性校验（2026-09-22 扩容时建立）。
 *
 * 这三条不变量若破，评测数字就失去意义，故用单测钉住（无需索引语料，毫秒级）：
 * ① 结构完整：每条含非空 `q` 与 `anchor`，且无重复查询文本；
 * ② 规模达标：全量 ≥80 条（扩容目标），冻结子集恰为 33 条（历史口径不可漂移）；
 * ③ 对抗性：新增条目（{@link EXTENDED_RECALL_QUERIES}）的查询内容词与锚点子词**零交集**
 *    —— 否则 BM25 靠字面白送分，度量不到「非字面检索」能力。
 *
 * 锚点是否真实存在（GT 非空）需要索引语料，属慢检查，放在
 * `evals/recall-query-audit.mjs`（评测侧门禁，缺失即中止）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CORE_COUNT,
  CORE_RECALL_QUERIES,
  EXTENDED_RECALL_QUERIES,
  RECALL_QUERIES,
  adversarialOverlap,
  anchorTokensOf,
  contentTokensOf,
} from '../fixtures/recallQueries.js';

test('① 结构完整：字段非空且查询文本不重复', () => {
  const seen = new Set();
  for (const entry of RECALL_QUERIES) {
    assert.ok(
      typeof entry.q === 'string' && entry.q.trim() !== '',
      `空查询：${JSON.stringify(entry)}`,
    );
    assert.ok(
      typeof entry.anchor === 'string' && entry.anchor.trim() !== '',
      `空锚点：${JSON.stringify(entry)}`,
    );
    assert.ok(!seen.has(entry.q), `重复查询：${entry.q}`);
    seen.add(entry.q);
  }
});

test('② 规模达标：全量 ≥80 条，冻结子集恰为 33 条', () => {
  assert.ok(RECALL_QUERIES.length >= 80, `全量仅 ${RECALL_QUERIES.length} 条（目标 ≥80）`);
  assert.strictEqual(CORE_COUNT, 33, '冻结的历史子集必须恰为 33 条（看板 §17 数字依赖它）');
  assert.strictEqual(CORE_RECALL_QUERIES.length, 33);
  assert.strictEqual(
    RECALL_QUERIES.length,
    CORE_RECALL_QUERIES.length + EXTENDED_RECALL_QUERIES.length,
  );
});

test('③ 对抗性：新增条目的查询内容词与锚点子词零交集', () => {
  for (const entry of EXTENDED_RECALL_QUERIES) {
    const overlap = adversarialOverlap(entry);
    assert.deepStrictEqual(
      overlap,
      [],
      `查询「${entry.q}」与锚点「${entry.anchor}」字面重合：${overlap.join(', ')}`,
    );
  }
});

test('④ 工具函数自洽：camelCase / 分隔符拆分口径与检索侧一致', () => {
  assert.deepStrictEqual(
    [...anchorTokensOf('ApprovalTierCatalog')],
    ['approval', 'tier', 'catalog'],
  );
  // 前置的 TS 关键字同样被切成词元（对判定无害），此处显式钉住以免日后误解
  assert.ok(anchorTokensOf('class ApprovalTierCatalog').has('approval'));
  assert.deepStrictEqual([...anchorTokensOf('reasoning_effort')], ['reasoning', 'effort']);
  // 功能词不算内容词（否则 "how does X work" 会被误判为重合）
  assert.ok(!contentTokensOf('how does the matcher work').has('how'));
  assert.ok(contentTokensOf('how does the matcher work').has('matcher'));
});

test('⑤ 新增条目覆盖多域（防止扩容后集合退化为单域样本）', () => {
  // 用锚点所在目录前缀无法在纯数据层判断，改为检查域相关关键词的出现次数下限，
  // 保证「权限/检索/安全/服务端/观测/进化/工具」至少各有一条。
  const all = EXTENDED_RECALL_QUERIES.map((e) => e.anchor).join(' ');
  for (const keyword of [
    'Approval',
    'Recall',
    'Egress',
    'Session',
    'Audit',
    'Anneal',
    'Concurrency',
  ]) {
    assert.ok(all.includes(keyword), `新增条目缺少 ${keyword} 域样本`);
  }
});
