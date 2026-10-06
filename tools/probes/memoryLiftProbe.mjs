#!/usr/bin/env node
/**
 * 记忆 primer **机制级**判据探针（G9-c/M1，2026-10-03；**离线、免网络、免模型、确定性**）。
 *
 * ## 回答什么问题
 *
 * 长期记忆的 primer 只在 `OMNI_MEMORY_PRIMER=1` 时注入（最多 5 条）。它的"增益"在本仓**从未有数字**——
 * 而报告 M1 明确要求"**先能判死、再谈投入**"。本探针给的就是那个可判死的量。
 *
 * ## 口径：**机制级**，不是 LLM 增益（这是本探针最重要的边界）
 *
 * 离线无 key 时，任何"primer on/off 的任务成功率 A/B"都只能**测到我自己的脚本模型**（假数字）。
 * 故本探针量的是**机制**——回灌内容本身：
 *  - **注入覆盖率**：多少条查询至少注入了 1 条事实（primer 关时为 0）；
 *  - **相关性（hitRate@5）**：查询**所问的那条事实**是否进了 primer 的 5 个名额
 *    （选择口径与生产一致：`memory.recall(prompt, 5)`，见 `src/core/sessionInjector.ts`）；
 *  - **代价**：回灌文本的估算 token（`TokenEstimator.estimate`）。
 *
 * **它不能证明**"记忆让任务更成功"——那需要真实模型与任务集。本探针只回答："回灌的内容是否**相关**、
 * 代价多大、以及这套判据**有没有判死能力**"。
 *
 * ## 判死能力自证（本探针的灵魂）
 *
 * 若判据只会说好话就没有价值。故内置**随机注入对照**：同样的 5 个名额，改成从记忆库里**随机**取，
 * 相关性应显著下降。若随机对照与召回几乎一样（就像本仓已证伪的图检索"查询不敏感"那样），
 * 说明**判据本身没有区分力** ⇒ 输出会明确给出 `controlDiscriminates: false` 并以退出码 3 提示。
 *
 * ## 前置
 *
 * 需要编译产物：先 `npm run build`（本探针 import `dist/src/**`）。
 *
 * ## 用法
 *
 * ```bash
 * node tools/probes/memoryLiftProbe.mjs [--k=5] [--json=out.json]
 * ```
 *
 * ## 诚实边界
 *
 * - 记忆库由本探针**自建夹具**（每条事实带唯一锚点词），不代表真实记忆库的分布；
 * - 相关性用"锚点命中"机械判定（无模型、无标注噪声），因此它测的是**检索机制**，不是"这条事实对不对"；
 * - primer 关时覆盖率恒 0、代价恒 0（这是构造性的，不是测出来的"增益"）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { probeArgs } from './_args.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 仓库根（本文件在 `tools/probes/` 下，故上溯两级）。 */
const ROOT = join(HERE, '..', '..');
const importDist = (...segments) =>
  import(pathToFileURL(join(ROOT, 'dist', 'src', ...segments)).href);

// 参数解析排在 dist 动态 import **之前**（理由见 `_args.mjs` 头注释）。
const a = probeArgs({ values: { k: '5', json: '' } });

let FileLongTermMemory;
let TokenEstimator;
try {
  ({ FileLongTermMemory } = await importDist('adapters', 'memory', 'fileLongTermMemory.js'));
  ({ TokenEstimator } = await importDist('context', 'tokenEstimator.js'));
} catch (error) {
  console.error(
    '✗ 缺少编译产物。请先运行 `npm run build`。\n' +
      `  原因：${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(2);
}

const K = Number(a.k);
const JSON_OUT = String(a.json);
if (!Number.isInteger(K) || K <= 0) {
  console.error('✗ --k 必须是正整数（例：--k=5）');
  process.exit(2);
}
/** 与生产一致的 primer 名额（`sessionInjector.injectMemoryPrimer` 用 5）。 */
const PRIMER_BUDGET = K;

/** 夹具：每条事实一个**唯一锚点词**（英文，便于机械判定与 BM25 命中）。 */
const FACTS = [
  { anchor: 'pnpmworkspace', text: '本仓用 pnpmworkspace 管理多包依赖' },
  { anchor: 'restrictedpolicy', text: '沙箱默认档是 restrictedpolicy' },
  { anchor: 'vaultkey', text: '长期记忆加密密钥文件叫 vaultkey' },
  { anchor: 'sqlitestore', text: '事件落盘用 sqlitestore 通道' },
  { anchor: 'rewindcursor', text: '回滚后要重对齐 rewindcursor 游标' },
  { anchor: 'subagentseed', text: '子代理装配走 subagentseed 种子' },
  { anchor: 'otlptrace', text: '追踪导出到 otlptrace 端点' },
  { anchor: 'bm25morph', text: '检索分词含 bm25morph 词形归并' },
];

/**
 * 查询夹具：**每条查询恰好问到一条事实的锚点**（故"该被注入的那条"是确定的，无需标注）。
 * 另加两条**问不到任何事实**的查询（用于观察噪声与覆盖率）。
 */
const QUERIES = [
  ...FACTS.map((fact) => ({ q: `我们用的是 ${fact.anchor} 吗`, want: fact.anchor })),
  { q: '今天天气怎么样', want: null },
  { q: '顺便问一句午饭吃什么', want: null },
];

/**
 * 造记忆库（临时目录，跑完删除）。
 * @returns {{memory: object, cleanup: () => void}} 记忆端口与清理函数。
 */
function buildStore() {
  const dir = mkdtempSync(join(tmpdir(), 'omni-memory-probe-'));
  const memory = new FileLongTermMemory(join(dir, 'memory.jsonl'));
  for (const [i, fact] of FACTS.entries()) {
    memory.remember({
      id: `f${String(i)}`,
      text: fact.text,
      importance: 3,
      createdAt: new Date(0).toISOString(),
      sessionId: 'seed-session',
      source: 'tool',
    });
  }
  return { memory, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * 确定性伪随机（固定种子 ⇒ 跨机同结果）。
 * @param {number} seed 种子。
 * @returns {() => number} [0,1) 生成器。
 */
function rng(seed) {
  let state = seed >>> 0;
  return () => (state = (state * 1664525 + 1013904223) >>> 0) / 0x100000000;
}

/**
 * 跑一轮测量（primer 关 / 开 / 随机对照）。
 * @param {object} memory 记忆端口。
 * @param {'off'|'on'|'random'} mode 模式。
 * @returns {{rows: object[], coverage: number, hitRate: number, tokens: number}} 汇总。
 */
function measure(memory, mode) {
  const estimator = new TokenEstimator();
  const random = rng(0x5eed);
  const rows = [];
  /** 每行的回灌文本（供代价口径使用；与 rows 同序）。 */
  const injectedLines = [];
  for (const { q, want } of QUERIES) {
    let picked = [];
    if (mode === 'on') {
      picked = memory.recall(q, PRIMER_BUDGET).filter((f) => f.sessionId !== 'probe-session');
    } else if (mode === 'random') {
      const all = [...memory.all()];
      picked = [];
      while (picked.length < Math.min(PRIMER_BUDGET, all.length)) {
        picked.push(all[Math.floor(random() * all.length)]);
      }
    }
    const injected = picked.map((f) => f.text).join('\n');
    injectedLines.push(injected);
    const hit = want === null ? null : picked.some((f) => f.text.includes(want));
    rows.push({ q, want, injected: picked.length, hit });
  }
  const asked = rows.filter((r) => r.want !== null);
  const hits = asked.filter((r) => r.hit === true).length;
  const withInjection = rows.filter((r) => r.injected > 0).length;
  // 代价口径：**回灌文本自身**的估算 token 之和（不是查询文本——那与 primer 无关）。
  const tokens = rows.reduce(
    (sum, row, i) => sum + estimator.estimate(row.injected === 0 ? '' : injectedLines[i]),
    0,
  );
  return {
    rows,
    coverage: withInjection / rows.length,
    hitRate: asked.length === 0 ? 0 : hits / asked.length,
    tokens,
  };
}

/**
 * 配对 bootstrap 95% CI（固定种子）。
 * @param {readonly number[]} delta 逐查询差值。
 * @returns {[number, number]} CI（百分点）。
 */
function pairedCI(delta) {
  if (delta.length === 0) return [0, 0];
  const random = rng(0xc0ffee);
  const means = [];
  for (let round = 0; round < 4000; round += 1) {
    let sum = 0;
    for (let i = 0; i < delta.length; i += 1) sum += delta[Math.floor(random() * delta.length)];
    means.push((sum / delta.length) * 100);
  }
  means.sort((a, b) => a - b);
  return [
    +means[Math.floor(0.025 * means.length)].toFixed(2),
    +means[Math.floor(0.975 * means.length)].toFixed(2),
  ];
}

/**
 * repeated 2-fold 留出折。
 * @param {readonly number[]} delta 逐查询差值。
 * @returns {{neg: number, total: number}} 折统计。
 */
function folds(delta) {
  if (delta.length === 0) return { neg: 0, total: 0 };
  const random = rng(0x9e3779b9);
  const out = [];
  for (let round = 0; round < 20; round += 1) {
    const ix = delta.map((_, i) => i);
    for (let i = ix.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [ix[i], ix[j]] = [ix[j], ix[i]];
    }
    const half = Math.floor(ix.length / 2);
    const avg = (xs) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
    out.push(avg(ix.slice(0, half).map((i) => delta[i])) * 100);
    out.push(avg(ix.slice(half).map((i) => delta[i])) * 100);
  }
  return { neg: out.filter((x) => x < -1e-9).length, total: out.length };
}

const { memory, cleanup } = buildStore();
try {
  const off = measure(memory, 'off');
  const on = measure(memory, 'on');
  const ctrl = measure(memory, 'random');

  const deltaOn = on.rows.map(
    (r, i) => (r.hit === true ? 1 : 0) - (off.rows[i].hit === true ? 1 : 0),
  );
  const deltaCtrl = on.rows.map(
    (r, i) => (r.hit === true ? 1 : 0) - (ctrl.rows[i].hit === true ? 1 : 0),
  );
  const ciOn = pairedCI(deltaOn);
  const ciCtrl = pairedCI(deltaCtrl);
  const foldsOn = folds(deltaOn);
  const controlDiscriminates = ciCtrl[0] > 0 && folds(deltaCtrl).neg === 0;

  const report = {
    probe: 'memoryLiftProbe',
    caliber: '机制级（注入覆盖率 / 相关性 hitRate@5 / 代价）；**不是** LLM 任务增益，见文件头',
    budget: PRIMER_BUDGET,
    facts: FACTS.length,
    queries: QUERIES.length,
    off: { coverage: off.coverage, hitRate: off.hitRate, injectedTokens: off.tokens },
    on: {
      coverage: on.coverage,
      hitRate: on.hitRate,
      injectedTokens: on.tokens,
      ci95: ciOn,
      folds: foldsOn,
    },
    // **对照必须非退化**：随机注入要真的注入（覆盖率 > 0），否则"0% < 100%"这种对比证明不了判据有区分力。
    randomControl: {
      hitRate: ctrl.hitRate,
      coverage: ctrl.coverage,
      injectedTokens: ctrl.tokens,
      ci95: ciCtrl,
    },
    controlDiscriminates,
  };

  console.log(
    `记忆库 ${String(FACTS.length)} 条 / 查询 ${String(QUERIES.length)} 条 ｜ primer 名额 ${String(PRIMER_BUDGET)}\n`,
  );
  console.log(
    `  primer 关   ：覆盖率 ${(off.coverage * 100).toFixed(1)}%  相关性 ${(off.hitRate * 100).toFixed(1)}%`,
  );
  console.log(
    `  primer 开   ：覆盖率 ${(on.coverage * 100).toFixed(1)}%  相关性 ${(on.hitRate * 100).toFixed(1)}%  ` +
      `ΔCI ${JSON.stringify(ciOn)}pp  折负 ${String(foldsOn.neg)}/${String(foldsOn.total)}  回灌代价 ${String(on.tokens)} token`,
  );
  console.log(
    `  随机对照    ：覆盖率 ${(ctrl.coverage * 100).toFixed(1)}%  相关性 ${(ctrl.hitRate * 100).toFixed(1)}%  ΔCI(vs 开) ${JSON.stringify(ciCtrl)}pp`,
  );
  console.log(
    `\n  判死能力自证：${controlDiscriminates ? '✓ 有区分力（随机对照显著更差）' : '✗ 无区分力（随机对照与召回几乎一样 ⇒ 判据不可信）'}`,
  );
  console.log(
    '  口径提醒：本探针量**回灌内容**（覆盖率/相关性/代价），**不能**证明"记忆让任务更成功"——' +
      '后者需要真实模型与任务集（离线无 key 时做 A/B 只会测到自己的脚本模型）。',
  );

  if (JSON_OUT !== '') {
    writeFileSync(JSON_OUT, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\n已写出 ${JSON_OUT}`);
  }
  if (!controlDiscriminates) {
    process.exit(3);
  }
} finally {
  cleanup();
}
