/**
 * 出货默认模型的**价目覆盖**判据（2026-10-11）。
 *
 * ## 它拦的是什么
 *
 * 成本硬预算（`--cost-budget-usd` / `costBudgetUsd`）按 `RoutePricing` 的价目折算花费，
 * 未命中价目时**静默**取兜底价（1.0/3.0 USD per 1M）。兜底价与真实单价可差数倍，且方向不定：
 *
 *  - **偏低 ⇒ 熔断过晚（fail-open）**：实测 `claude-sonnet-4-20250514`（`defaults/providers.json`
 *    里 anthropic 预设的默认模型）真价 3/15，而兜底价把它低估 **3×/5×**；
 *  - 偏高 ⇒ 熔断过早（把还能用的额度提前掐掉）。
 *
 * 两者对**出货默认**都不可接受，而此前这件事在快照里看不出来——`priceFor` 悄悄返回兜底价，
 * 预算工具照样报一个精确到小数点后 6 位的 `spentUsd`。
 *
 * ## 判据口径
 *
 * 出货模型（零配置就能用到的那些：厂商预设的 `defaultModel` 与 `models` 列表、端点兜底模型、
 * CLI 缺省模型）**必须**落在「价目表命中」或「显式登记的无价目族」之一；两边都没有 ⇒ 红。
 * 新增厂商预设时若忘了定价，门禁当场变红，而不是静默按兜底价算钱。
 *
 * 判据同时钉住**运行期自报**（`BudgetSnapshot.unpricedModels` + `budget_status`），
 * 因为"清单齐全"与"用户看得见"是两件事：只做前者，估算不可信仍然只在代码里。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArgParser } from '../../src/cli/argParser.js';
import { CostBudget } from '../../src/adapters/model/costBudget.js';
import { BudgetStatusTool } from '../../src/adapters/tool/meta/budgetStatusTool.js';
import {
  DEFAULT_FALLBACK_PRICE,
  RoutePricing,
  UNPRICED_DEFAULT_FAMILIES,
} from '../../src/adapters/model/routePricing.js';

/** 仓库根（编译产物在 `dist/tests/unit/`）。 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** 一条出货模型记录（模型 id + 它在哪个文件里出货，便于报错时定位）。 */
interface ShippedModel {
  readonly model: string;
  readonly from: string;
}

/**
 * 收集「零配置就能用到」的模型 id。
 *
 * 为什么要读**真实文件**而不是在测试里抄一份清单：抄的那份会漂——本判据的价值恰恰是
 * "新增预设时忘定价就红"，抄一份清单等于把这个能力取消。
 * @returns 出货模型列表（含来源标注）。
 */
function shippedModels(): ShippedModel[] {
  const out: ShippedModel[] = [];
  const providers = JSON.parse(
    readFileSync(join(REPO_ROOT, 'defaults', 'providers.json'), 'utf8'),
  ) as {
    presets: readonly { id: string; defaultModel: string; models?: readonly string[] }[];
  };
  for (const preset of providers.presets) {
    out.push({ model: preset.defaultModel, from: `providers.json:${preset.id}.defaultModel` });
    for (const model of preset.models ?? []) {
      out.push({ model, from: `providers.json:${preset.id}.models` });
    }
  }
  const endpoints = JSON.parse(
    readFileSync(join(REPO_ROOT, 'defaults', 'endpoints.json'), 'utf8'),
  ) as {
    modelAdapters: readonly { id: string; model: string }[];
  };
  for (const adapter of endpoints.modelAdapters) {
    out.push({ model: adapter.model, from: `endpoints.json:${adapter.id}.model` });
  }
  const cli = ArgParser.parseArgs(['--prompt', 'x']);
  assert.ok(cli !== undefined, 'CLI 缺省解析必须成功，否则本判据的 CLI 缺省一路是空转');
  assert.ok(
    typeof cli.model === 'string' && cli.model.length > 0,
    `CLI 缺省模型必须非空（实为 ${String(cli.model)}）`,
  );
  out.push({ model: cli.model, from: 'argParser 缺省（CliDefaults.model）' });
  return out;
}

test('① 出货模型必须"有价目"或"有明确的不定价登记"——两者都没有即红（静默落兜底价）', () => {
  const pricing = RoutePricing.mergeRoutePricing();
  const unclassified: string[] = [];
  const lines: string[] = [];
  const models = shippedModels();
  for (const { model, from } of models) {
    const res = RoutePricing.resolve(model, pricing, DEFAULT_FALLBACK_PRICE);
    const registered = RoutePricing.unpricedDefaultFor(model);
    if (res.source === 'fallback' && registered === null) {
      unclassified.push(`${model}（来自 ${from}）`);
    }
    lines.push(
      `${model} → ${res.source}${res.key === null ? '' : `(${res.key})`}` +
        `${registered === null ? '' : ` [登记:${registered.key}]`}`,
    );
  }
  // 仪器自证：出货清单过少说明本判据根本没覆盖到真实清单（例如 JSON 结构变了而解析静默空转）。
  assert.ok(
    models.length >= 15,
    `出货模型数过少（${String(models.length)}）⇒ 判据没覆盖真实清单，先查 defaults/*.json 的解析`,
  );
  assert.deepStrictEqual(
    unclassified,
    [],
    `这些出货模型既不在价目表也没有登记理由 ⇒ 会静默按兜底价算钱：\n${unclassified.join('\n')}`,
  );
  // 证据打印走 `process.stdout.write`：本仓编码标准 §12.2 把 `console.log` 判为调试残留
  // （豁免的是"正道"里的两条：结构化 `log` 与 `process.stdout.write`），新文件不得新增。
  process.stdout.write(`[出货模型定价] 共 ${String(models.length)} 项 ｜ ${lines.join(' ｜ ')}\n`);
});

test('② 登记表每条都要写清理由，且不得与价目表自相矛盾', () => {
  const entries = Object.entries(UNPRICED_DEFAULT_FAMILIES);
  assert.ok(entries.length > 0, '登记表不得为空（空表会让判据①失去意义）');
  const pricing = RoutePricing.mergeRoutePricing();
  for (const [key, reason] of entries) {
    assert.ok(
      reason.trim().length >= 10,
      `登记项 ${key} 的理由过短——"不定价"也必须写清是"查不到"还是"本来就是 0"：${reason}`,
    );
    assert.ok(
      !pricing.has(key),
      `${key} 既是价目表键又被登记为"没有价目" ⇒ 两处结论相反，必须二选一`,
    );
  }
});

test('③ 登记表不得成为垃圾桶：每个键都必须被某个出货模型真正命中', () => {
  const models = shippedModels().map((item) => item.model);
  const unused = Object.keys(UNPRICED_DEFAULT_FAMILIES).filter(
    (key) => !models.some((model) => model.startsWith(key)),
  );
  assert.deepStrictEqual(
    unused,
    [],
    `这些登记键没有任何出货模型命中 ⇒ 要么删掉，要么前缀写错了：${unused.join(', ')}`,
  );
});

test('④ 回归钉：出货的 Anthropic 两档不得再落兜底价（实测曾低估 3×/5×）', () => {
  const pricing = RoutePricing.mergeRoutePricing();
  const sonnet = RoutePricing.resolve('claude-sonnet-4-20250514', pricing, DEFAULT_FALLBACK_PRICE);
  assert.strictEqual(
    sonnet.source,
    'prefix',
    'Anthropic 出货默认必须前缀命中价目表（不得落兜底价）',
  );
  assert.strictEqual(sonnet.price.inputPer1M, 3);
  assert.strictEqual(sonnet.price.outputPer1M, 15);
  const opus = RoutePricing.resolve('claude-opus-4-20250514', pricing, DEFAULT_FALLBACK_PRICE);
  assert.strictEqual(opus.source, 'prefix');
  assert.strictEqual(opus.price.inputPer1M, 15);
  assert.strictEqual(opus.price.outputPer1M, 75);
  // 反面对照：真没价目的模型仍须落兜底价——否则"给所有模型定价"就能骗过判据①。
  const unknown = RoutePricing.resolve('no-such-model-xyz', pricing, DEFAULT_FALLBACK_PRICE);
  assert.strictEqual(unknown.source, 'fallback');
  assert.strictEqual(unknown.key, null);
});

test('⑤ 运行期自报：按兜底价估算的模型必须出现在快照的 unpricedModels 里', () => {
  const pricing = RoutePricing.mergeRoutePricing();
  const usage = { promptTokens: 1000, completionTokens: 100, totalTokens: 1100 };
  const budget = new CostBudget(100, pricing, undefined, undefined, false);
  budget.record('claude-sonnet-4-20250514', usage); // 有价目
  budget.record('deepseek-v4-flash', usage); // 无价目（已登记）
  budget.record('deepseek-v4-flash', usage); // 重复调用不得重复登记
  assert.deepStrictEqual(budget.unpricedModels, ['deepseek-v4-flash']);
  assert.strictEqual(budget.priceSourceFor('claude-sonnet-4-20250514'), 'prefix');
  assert.strictEqual(budget.priceSourceFor('deepseek-v4-flash'), 'fallback');
  assert.deepStrictEqual(budget.snapshot().unpricedModels, ['deepseek-v4-flash']);

  // 变异自证：全部命中价目时必须为空数组——否则"非空"这件事没有信息量。
  const clean = new CostBudget(100, pricing, undefined, undefined, false);
  clean.record('claude-sonnet-4-20250514', usage);
  assert.deepStrictEqual(clean.unpricedModels, []);
  assert.deepStrictEqual(clean.snapshot().unpricedModels, []);
});

test('⑥ 消费面接线：budget_status 必须把"估算基于兜底价"讲出来（自报不能停在快照里）', async () => {
  const pricing = RoutePricing.mergeRoutePricing();
  const usage = { promptTokens: 100, completionTokens: 10, totalTokens: 110 };
  const budget = new CostBudget(100, pricing, undefined, undefined, false);
  budget.record('deepseek-v4-flash', usage);
  const res = await new BudgetStatusTool(budget).handle(
    { id: 'c1', name: 'budget_status', arguments: {} },
    { sessionId: 's', workspaceRoot: '.' },
  );
  const parsed = JSON.parse(res.output ?? '{}') as {
    unpricedModels: string[];
    pricingNote: string;
  };
  assert.deepStrictEqual(parsed.unpricedModels, ['deepseek-v4-flash']);
  assert.ok(
    parsed.pricingNote.includes('兜底价'),
    `提示必须点明"按兜底价估算"，实为：${parsed.pricingNote}`,
  );

  // 反面对照：全部命中价目时不得报告"不可信"（否则提示会退化成噪声而被忽略）。
  const clean = new CostBudget(100, pricing, undefined, undefined, false);
  clean.record('claude-sonnet-4-20250514', usage);
  const cleanRes = await new BudgetStatusTool(clean).handle(
    { id: 'c2', name: 'budget_status', arguments: {} },
    { sessionId: 's', workspaceRoot: '.' },
  );
  const cleanParsed = JSON.parse(cleanRes.output ?? '{}') as {
    unpricedModels: string[];
    pricingNote: string;
  };
  assert.deepStrictEqual(cleanParsed.unpricedModels, []);
  assert.ok(!cleanParsed.pricingNote.includes('兜底价'));
});
