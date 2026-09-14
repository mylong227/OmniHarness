import test from 'node:test';
import assert from 'node:assert/strict';

import {
  type Cost,
  emptyCost,
  cost,
  concatCost,
  vectorConcat,
  vectorEmpty,
} from '../../src/genesis/algebra.js';
import {
  encodeText,
  encodeImage,
  mapModality,
  fuseModality,
  alignModality,
  type Modality,
} from '../../src/genesis/modalityPort.js';
import {
  type Operator,
  identityOperator,
  composeOperator,
  liftOperator,
} from '../../src/genesis/operator.js';
import { Ledger, sumCosts } from '../../src/genesis/ledger.js';
import {
  type GenesisState,
  deriveEntropy,
  characteristicRegime,
  fuseOperator,
  pruneOperator,
  plan,
  adaptOnce,
} from '../../src/genesis/regimeCost.js';

// ---- 1. Cost 交换幺半群：结合律 / 单位元 ----

test('Cost 幺半群：结合律（浮点容差，ℝ 中严格成立）', () => {
  const a = cost(3);
  const b = cost(5);
  const c = cost(7);
  const left = concatCost(concatCost(a, b), c);
  const right = concatCost(a, concatCost(b, c));
  // token 为整数可精确比较；joules 为浮点，结合律在 ℝ 中严格成立，浮点近似需容差
  assert.strictEqual(left.tokens, right.tokens);
  assert.ok(Math.abs(left.joules - right.joules) < 1e-12);
});

test('Cost 幺半群：左/右单位元', () => {
  const a = cost(11);
  assert.deepStrictEqual(concatCost(emptyCost, a), a);
  assert.deepStrictEqual(concatCost(a, emptyCost), a);
});

test('Cost 幺半群：交换律（与顺序无关）', () => {
  const a = cost(4);
  const b = cost(9);
  assert.deepStrictEqual(concatCost(a, b), concatCost(b, a));
});

// ---- 2. 向量自由幺半群 ----

test('向量拼接：结合律与单位元', () => {
  const a = [1, 2];
  const b = [3, 4];
  const c = [5];
  assert.deepStrictEqual(vectorConcat(vectorConcat(a, b), c), vectorConcat(a, vectorConcat(b, c)));
  assert.deepStrictEqual(vectorConcat(a, vectorEmpty(0)), a);
});

// ---- 3. Modality 函子定律 ----

test('Modality 函子：map 恒等律', () => {
  const m = encodeText('hello');
  const id = mapModality(m, (s: string) => s);
  assert.strictEqual(id.data, m.data);
  assert.deepStrictEqual([...id.features], [...m.features]);
});

test('Modality 函子：map 组合律', () => {
  const m = encodeText('abc');
  const f = (s: string) => s.length;
  const g = (n: number) => n * 2;
  const left = mapModality(mapModality(m, f), g);
  const right = mapModality(m, (s) => g(f(s)));
  assert.strictEqual(left.data, right.data);
});

test('Modality 融合：交换律（fuse(a,b) ≡ fuse(b,a)）', () => {
  const ta = encodeText('alpha');
  const tb = encodeText('beta');
  const fab = fuseModality(ta, tb);
  const fba = fuseModality(tb, ta);
  assert.deepStrictEqual([...fab.features], [...fba.features]);
  assert.strictEqual(fab.kind, fba.kind);
});

test('Modality 对齐：同文本相似度≈1，异文本<1，跨模态可比较', () => {
  const a = encodeText('风险对冲模型');
  const b = encodeText('风险对冲模型');
  const c = encodeText('量子退火原理');
  assert.ok(Math.abs(alignModality(a, b) - 1) < 1e-9);
  assert.ok(alignModality(a, c) < alignModality(a, b));
  const img = encodeImage(new Uint8Array([10, 20, 30, 40, 50, 60]), 2, 3);
  // 跨模态对齐有定义且落在 [-1,1]
  const cross = alignModality(a as Modality<unknown>, img as Modality<unknown>);
  assert.ok(cross >= -1 && cross <= 1);
});

// ---- 4. Operator 组合幺半群 ----

test('Operator 组合：结合律', () => {
  const inc = liftOperator<number>((s) => s + 1);
  const dbl = liftOperator<number>((s) => s * 2);
  const halve = liftOperator<number>((s) => s / 2);
  const left = composeOperator(composeOperator(inc, dbl), halve);
  const right = composeOperator(inc, composeOperator(dbl, halve));
  assert.strictEqual(left(7).next, right(7).next);
});

test('Operator 组合：左/右单位元', () => {
  const op = liftOperator<number>((s) => s + 100);
  const id = identityOperator<number>();
  assert.strictEqual(composeOperator(id, op)(5).next, op(5).next);
  assert.strictEqual(composeOperator(op, id)(5).next, op(5).next);
});

// T1.1（REFACTOR_BOARD）：lift 必须是「函数组合幺半群 → 算子幺半群」的同态——
// lift(g∘f) ≡ lift(f) ∘ lift(g)（保组合）且 lift(id) ≡ identityOperator（保单位元）。
// 两者成立 ⇒ liftOperator 的 L3 声明有证据；任一失败 ⇒ 降级 L1。
test('Operator 提升保组合律：lift(g∘f) ≡ lift(f) ∘ lift(g)', () => {
  const f = (n: number) => n + 1;
  const g = (n: number) => n * 2;
  const direct = liftOperator((n: number) => g(f(n)));
  const viaCompose = composeOperator(liftOperator(f), liftOperator(g));
  for (const s of [0, 7, -3, 100]) {
    const a = direct(s);
    const b = viaCompose(s);
    assert.strictEqual(b.next, a.next);
    assert.strictEqual(b.cost.tokens, a.cost.tokens);
    assert.strictEqual(b.cost.joules, a.cost.joules);
    assert.deepStrictEqual([...b.events], [...a.events]);
  }
});

test('Operator 提升保单位元：lift(id) ≡ identityOperator', () => {
  const liftedId = liftOperator((n: number) => n);
  const identity = identityOperator<number>();
  for (const s of [0, 42]) {
    const a = liftedId(s);
    const b = identity(s);
    assert.strictEqual(a.next, b.next);
    assert.strictEqual(a.cost.tokens, b.cost.tokens);
    assert.strictEqual(a.cost.joules, b.cost.joules);
    assert.deepStrictEqual([...a.events], [...b.events]);
  }
});

// ---- 5. Ledger 守恒律 ----

test('Ledger：record+commit 后守恒', () => {
  const ledger = new Ledger();
  ledger.record(cost(10));
  ledger.record(cost(20));
  ledger.commit();
  assert.strictEqual(ledger.isConserved(), true);
});

test('Ledger：记录后未 commit ⇒ 不守恒（可机械检出遗漏）', () => {
  const ledger = new Ledger();
  ledger.record(cost(10));
  assert.strictEqual(ledger.isConserved(), false);
  ledger.commit();
  assert.strictEqual(ledger.isConserved(), true);
});

test('Ledger：sumCosts 复用 Cost 幺半群', () => {
  const total = sumCosts([cost(1), cost(2), cost(3)]);
  assert.strictEqual(total.tokens, 6);
});

// ---- 6. Regime 控制器：收敛性与单调性（可推演） ----

function mkState(
  modalities: GenesisState['modalities'],
  spentTokens: number,
  budgetTokens = 1000,
): GenesisState {
  return { modalities, budget: cost(budgetTokens), spent: cost(spentTokens), step: 0 };
}

test('deriveEntropy：单模态熵为0，多模态熵>0', () => {
  assert.strictEqual(deriveEntropy(['text']), 0);
  assert.ok(deriveEntropy(['text', 'image', 'audio']) > 0.5);
});

test('pruneOperator 单调性：高压力减少模态，低压力恒等', () => {
  const high = mkState(['text', 'image', 'audio'], 900); // 压力 0.9
  const low = mkState(['text', 'image', 'audio'], 10); // 压力 0.01
  const rh = pruneOperator(high);
  const rl = pruneOperator(low);
  assert.strictEqual(rh.next.modalities.length, 2);
  assert.strictEqual(rl.next.modalities.length, 3);
});

test('plan 收敛到不动点（模态数良基递减）', () => {
  let s = mkState(['text', 'image', 'audio', 'video'], 950); // 高压力 → 触发剪枝
  const history: string[] = [];
  for (let i = 0; i < 20; i++) {
    const before = s.modalities.join(',');
    const op = plan(characteristicRegime(s));
    s = adaptOnce(s, { record: () => {} });
    history.push(before);
    // 一旦连续两步模态构成不变，即到达不动点
    if (history.length >= 2 && history[history.length - 1] === history[history.length - 2]) {
      break;
    }
  }
  // 不动点处 plan 退化为恒等：再应用不改变模态
  const fixed = s.modalities.join(',');
  const opFixed = plan(characteristicRegime(s));
  const s2 = opFixed(s);
  assert.strictEqual(s2.next.modalities.join(','), fixed);
});

test('plan 自适应选择：高熵多模态触发融合', () => {
  const s = mkState(['text', 'image', 'audio'], 10); // 熵>0.5 且 ≥3 模态
  const r = plan(characteristicRegime(s));
  // 应用后应发生融合（模态数减少）
  const out = r(s);
  assert.ok(out.events.includes('fuse'));
  assert.strictEqual(out.next.modalities.length, 2);
});
