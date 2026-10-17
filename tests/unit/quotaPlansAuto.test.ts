// 判据：配额档位的**模型识别**规则（`QuotaPlans.forModel` / `representative`）。
//
// 为什么值得单测：档位不再是用户手选的配置，而是由模型名推导出来的**配额倍率**（1× / 1.5× / 3×）。
// 规则表是有序的正则列表，最容易坏的地方是**优先级**——`gpt-4o-mini` 若被 `4o` 那条先吃掉，
// 一个轻量模型就会拿到 3 倍额度，而这种错误在界面上只表现为"数字偏大"，肉眼查不出来。
// 因此每条规则都配一条正例、以及一条会误命的**反例**。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuotaPlans, QUOTA_DEFAULT_ID } from '../../src/server/services/quotaPlans.js';

/**
 * 造一个档位目录。
 * @returns 目录实例
 */
function plans() {
  return new QuotaPlans();
}

test('未接入 / 未知模型 ⇒ 缺省档（free）', () => {
  const p = plans();
  for (const name of [undefined, '', '   ']) {
    assert.strictEqual(p.forModel(name).id, QUOTA_DEFAULT_ID, JSON.stringify(name));
  }
  // 认不出来的一串字符同样落缺省档：**宁可少给不可多给**（额度是约束）。
  assert.strictEqual(p.forModel('some-totally-unknown-model').id, 'free');
  assert.strictEqual(p.reasonFor('some-totally-unknown-model'), '', '未命中时依据为空串');
});

test('轻量档：mini / nano / flash / lite / small / turbo 一律 free（即使同名前缀是旗舰）', () => {
  const p = plans();
  const cases: readonly string[] = [
    'gpt-4o-mini',
    'gpt-4.1-mini',
    'o3-mini',
    'gemini-2.5-flash',
    'claude-3.5-haiku-lite',
    'deepseek-v4-small',
    'qwen2.5-turbo',
  ];
  for (const name of cases) {
    assert.strictEqual(p.forModel(name).id, 'free', `${name} 必须判为 free`);
  }
  // 正对照（优先级）：`gpt-4o-mini` 同时命中"4o"（旗舰规则）与"mini"（轻量规则）。
  // 若把 LIGHT_RULES 挪到 PRO_RULES 之后，本条立刻变红 ⇒ 这正是本文件要锁的性质。
  assert.strictEqual(p.forModel('gpt-4o-mini').id, 'free');
  assert.strictEqual(p.forModel('gpt-4o').id, 'pro');
});

test('本地 / 自托管模型 ⇒ free（不受本地日预算倍率约束）', () => {
  const p = plans();
  for (const name of ['llama3.1:8b', 'ollama/qwen2.5', 'local-model', 'gemma-2-9b', 'phi-3']) {
    assert.strictEqual(p.forModel(name).id, 'free', name);
  }
});

test('旗舰档：o 系列推理模型 / 4o / 4.1 / pro / max / opus ⇒ pro', () => {
  const p = plans();
  const cases: readonly string[] = [
    'o1',
    'o3',
    'o4',
    'gpt-4o',
    'gpt-4.1',
    'claude-3-opus',
    'claude-sonnet-4',
    'gpt-5',
    'deepseek-v4-pro',
    'gemini-2.5-pro',
    'grok-4-max',
    'deepseek-reasoner',
  ];
  for (const name of cases) {
    assert.strictEqual(p.forModel(name).id, 'pro', `${name} 必须判为 pro`);
  }
});

test('中档：通用主力命名（chat / standard / v<N>）⇒ plus', () => {
  const p = plans();
  for (const name of ['deepseek-chat', 'some-standard-model', 'vendor-v3']) {
    assert.strictEqual(p.forModel(name).id, 'plus', name);
  }
});

test('档位倍率与升级位：pro=3×、plus=1.5×、free=1×（界面徽标据此显示）', () => {
  const p = plans();
  assert.deepStrictEqual(
    [p.of('free').multiplier, p.of('plus').multiplier, p.of('pro').multiplier],
    [1, 1.5, 3],
  );
  assert.strictEqual(p.of('free').upgraded, false, 'free 不显示「升级」徽标');
  assert.strictEqual(p.of('plus').upgraded, true);
  assert.strictEqual(p.of('pro').upgraded, true);
});

test('of() 对未知 id 回退缺省档（fail-soft，不抛错）', () => {
  const p = plans();
  for (const id of [undefined, '', 'enterprise', 'PRO', 'pro ']) {
    assert.strictEqual(p.of(id).id, QUOTA_DEFAULT_ID, JSON.stringify(id));
  }
  assert.strictEqual(p.isValid('pro'), true);
  assert.strictEqual(p.isValid('PRO'), false, '大小写不是同一档');
});

test('representative：清单为空 ⇒ undefined（调用方落缺省档）', () => {
  const p = plans();
  assert.strictEqual(p.representative([]), undefined);
  assert.strictEqual(p.representative(['', '   ']), undefined);
});

test('representative：清单里同时有轻量与旗舰 ⇒ 取最高档（刚切旗舰不被免费档卡住）', () => {
  const p = plans();
  assert.strictEqual(p.representative(['gemini-2.5-flash', 'deepseek-v4-pro']), 'deepseek-v4-pro');
  assert.strictEqual(p.representative(['a-mini', 'b-chat']), 'b-chat', 'plus 高于 free');
});

test('reasonFor 给出可解释依据（面板要显示"为什么是这个档"）', () => {
  const p = plans();
  assert.match(p.reasonFor('deepseek-v4-pro'), /pro\/max\/ultra/, '旗舰命名要说明依据');
  assert.match(p.reasonFor('gpt-4o-mini'), /轻量词/, '轻量档要说明依据');
  assert.match(p.reasonFor(''), /^$/, '空模型名无依据');
});
