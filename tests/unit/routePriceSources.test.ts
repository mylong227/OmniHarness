/**
 * 价目**来源**判据（2026-10-11，目标 (2)「填入可复核真实单价」）。
 *
 * ## 判据要钉死什么
 *
 * 填数字容易，"这个数字凭什么"才是可复核性的全部。故本轮把来源做成**代码内的登记**
 * （`PRICE_SOURCES`：GitHub git blob 引用 + 取哪一条 + 例外说明），并用本判据钉住：
 *
 * | # | 判据 | 坏掉的后果 |
 * | --- | --- | --- |
 * | ① | 来源登记非空，`ref` 必须是**固定到 40 位 SHA** 的 https 引用 | 只写"来自某网站" ⇒ 换个时间无法复核 |
 * | ② | 来源 note 必须写明**取的是哪一条**（厂商直连 / 例外） | 拿转售价冒充厂商价 |
 * | ③ | 本轮新填的 17 个键必须**精确命中价目表**（不是前缀命中、更不是兜底） | 名字写错 ⇒ 静默落兜底价（等于没填） |
 * | ④ | 仍不定价的键的理由必须点明**查过什么**（含"不猜"/"不存在"语义） | 理由退化成"暂无来源"，看不出真查过 |
 * | ⑤ | 正对照：把某个键从价目表移除后，③ 的同一测量必须变红 | ③ 可能恒真 |
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_FALLBACK_PRICE,
  PRICE_SOURCES,
  RoutePricing,
  UNPRICED_DEFAULT_FAMILIES,
} from '../../src/adapters/model/routePricing.ts';

/** 本轮按公开价目填入的键（与 routePricing.ts 里的注释批次一致）。 */
const PRICED_THIS_ROUND: readonly string[] = [
  'deepseek-v4-flash',
  'deepseek-v4-flash-vision-exp',
  'deepseek-v4-pro',
  'moonshot-v1-8k',
  'moonshot-v1-32k',
  'moonshot-v1-128k',
  'glm-4.5',
  'glm-4.5-air',
  'glm-4.5-flash',
  'qwen-max',
  'qwen-plus',
  'qwen-turbo',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'claude-3-5-haiku',
  'gpt-4.1',
];

/**
 * 2026-10-15 批次：Moonshot 出货预设迁移到**现役**型号后填入的三个键。
 *
 * 为什么单独一批而不是并进上面那 17 个：那 17 个是 2026-10-11 的历史事实（含来源坐标），
 * 把新键塞进去会让"当时填了什么"变得不可考——本仓的惯例是**旧结论原样保留、新批次另立**。
 */
const PRICED_2026_10_15: readonly string[] = ['kimi-k2.6', 'kimi-k2.7-code', 'kimi-k3'];

test('① 来源登记必须固定到 40 位 SHA 的**坐标式**引用（地址不得进代码行）', () => {
  const entries = Object.entries(PRICE_SOURCES);
  assert.ok(entries.length > 0, '来源登记不得为空（空登记 = 数字无出处）');
  for (const [key, source] of entries) {
    assert.match(
      source.ref,
      /^repo:[^@]+@[0-9a-f]{40}#path=.+$/u,
      `${key} 的 ref 必须是坐标式引用（仓库@40位SHA#路径）——只写站点名无法复核`,
    );
    // 与 `endpointDefaults.test.ts` ⑤ 同一条纪律：`src/**` 的**代码行**不得出现硬编码地址。
    // 来源 URL 因此只写在注释里（注释允许提及地址），代码里留坐标。
    assert.ok(
      !source.ref.includes('http'),
      `${key} 的 ref 不得含地址（硬编码地址守卫会红；把 URL 写进注释即可）`,
    );
  }
});

test('② 来源 note 必须写明取的是哪一条（厂商直连 / 例外）', () => {
  for (const [key, source] of Object.entries(PRICE_SOURCES)) {
    assert.ok(source.note.trim().length >= 40, `${key} 的 note 过短，说不清取了哪一条`);
    assert.match(
      source.note,
      /厂商直连|例外/u,
      `${key} 的 note 必须点明"厂商直连"或"例外"（防拿转售价冒充厂商价）`,
    );
  }
  // 本仓唯一的"例外"是 3.5 Haiku（库里无 anthropic 直连条目，取 bedrock 同型号档）。
  // 钉**它所在的那条**而不是"每条都要提 Haiku"：后者在新增批次时会逼着新条目去复述一件与它无关的事
  //（2026-10-15 新增 Moonshot 现役型号批次时实测撞上），而历史结论本身仍是必须留痕的。
  const allNotes = Object.values(PRICE_SOURCES)
    .map((source) => source.note)
    .join('\n');
  assert.match(allNotes, /claude-3-5-haiku|Haiku/u, '来源登记里必须留痕那处唯一例外（3.5 Haiku）');
});

test('③ 本轮新填的 17 个键必须**精确命中**价目表（不是前缀命中、更不是兜底）', () => {
  const pricing = RoutePricing.mergeRoutePricing();
  const wrong: string[] = [];
  for (const key of PRICED_THIS_ROUND) {
    const res = RoutePricing.resolve(key, pricing, DEFAULT_FALLBACK_PRICE);
    if (res.source !== 'exact') {
      wrong.push(`${key} → ${res.source}${res.key === null ? '' : `(${res.key})`}`);
    }
  }
  assert.strictEqual(PRICED_THIS_ROUND.length, 17, '本轮清单应是 17 个键（改了批次就同步本清单）');
  assert.deepStrictEqual(
    wrong,
    [],
    `这些键没有精确命中价目表（名字写错就会静默落兜底价，等于没填）：\n${wrong.join('\n')}`,
  );
});

test('③-b 2026-10-15 批次：Moonshot 现役三个键也必须**精确命中**（名字写错即静默落兜底价）', () => {
  const pricing = RoutePricing.mergeRoutePricing();
  const wrong = PRICED_2026_10_15.filter(
    (key) => RoutePricing.resolve(key, pricing, DEFAULT_FALLBACK_PRICE).source !== 'exact',
  );
  assert.strictEqual(PRICED_2026_10_15.length, 3, '新批次的键数变了就同步本清单');
  assert.deepStrictEqual(wrong, [], `这些键没有精确命中价目表：\n${wrong.join('\n')}`);
  // **正对照**：从表里删掉一个键 ⇒ 同一测量必须不再判它精确命中（否则 ③-b 可能是恒真）。
  const local = new Map(RoutePricing.mergeRoutePricing());
  local.delete('kimi-k2.6');
  assert.notStrictEqual(
    RoutePricing.resolve('kimi-k2.6', local, DEFAULT_FALLBACK_PRICE).source,
    'exact',
    '删掉该键后仍判精确命中 ⇒ ③-b 的测量恒真',
  );
  // 另一条**诚实边界**（写进注释，不当判据）：名字**多加后缀**（如 `kimi-k2.6-turbo`）会走前缀命中，
  // 即"拼错"不会被兜底价接住而是被同族价接住——这是刻意的设计（变体沿用同族价），
  // 所以判据只能要求"出货名精确命中"，不能要求"任何错名都落兜底"。
});

test('④ 仍不定价的键：理由必须点明"查过什么"', () => {
  const entries = Object.entries(UNPRICED_DEFAULT_FAMILIES);
  assert.ok(entries.length > 0, '登记表不得为空');
  for (const [key, reason] of entries) {
    assert.match(
      reason,
      /不猜|不存在|没有|无法/u,
      `${key} 的理由必须说明"查过什么、为什么仍不给数字"：${reason}`,
    );
  }
  // 本轮已定价的族**不得**再同时留在登记表（判据②已查，这里再钉一次本轮清单）。
  for (const key of PRICED_THIS_ROUND) {
    assert.strictEqual(
      Object.keys(UNPRICED_DEFAULT_FAMILIES).includes(key),
      false,
      `${key} 已定价却仍在登记表里 ⇒ 两处结论相反`,
    );
  }
});

test('⑤ 正对照：把一个键拼错后，③ 的同一测量必须把它挑出来', () => {
  const pricing = RoutePricing.mergeRoutePricing();
  /**
   * 与 ③ 完全相同的测量逻辑（抽成局部函数，正对照才能证明"它挑得出来"）。
   * @param keys 待测键
   * @returns 未精确命中的键
   */
  const notExact = (keys: readonly string[]): string[] =>
    keys.filter((k) => RoutePricing.resolve(k, pricing, DEFAULT_FALLBACK_PRICE).source !== 'exact');
  assert.deepStrictEqual(notExact(['gpt-4.1']), [], '正常键必须精确命中');
  // 拼错一个字符 ⇒ 必须被挑出（否则 ③ 的"全部精确命中"没有信息量）。
  assert.deepStrictEqual(
    notExact(['gpt-4.1-typo']),
    ['gpt-4.1-typo'],
    '正对照失败：拼错的键仍被判为精确命中 ⇒ ③ 恒真',
  );
});
