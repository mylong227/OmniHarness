/**
 * **检索质量回归守卫**（G1b，2026-10-03 第六轮）。
 *
 * ## 为什么需要它（报告 §1.3 / §2.2 的 R1「验证真空」）
 *
 * 删除跑分/评测子系统后，检索/排序那 17 个模块、4,476 行核心代码**只剩机制单测、没有质量判据**；
 * 而"检索质量"恰恰是本项目最核心的能力面。本文件把最便宜的一格补回来：
 *
 *  - 语料：本仓 `src/`（light 档，跳过频谱/代码图/LSA——它们已被本项目多次自证伪）；
 *  - 查询：`CORE_RECALL_QUERIES`（32 条**冻结**查询，锚点是可在源码里逐字定位的 GT）；
 *  - 指标：`recall@14`（命中锚点所在文件的查询占比）与 `MRR`（首个命中位次倒数均值）；
 *  - 判据：**两个镜头**（`plain` 与生产用的 `rerank`）都必须 ≥ 入库基线 − 容差。
 *
 * ## 口径（必须随数字一起引用）
 *
 * 1. 这是 **floor 而不是 target**：只判"不许比基线差太多"，不判"必须达到基线"；
 * 2. 这是**回归守卫而非跑分**：没有外部基准、没有模型裁判、完全确定性（BM25 + 词法精排，无嵌入）；
 * 3. 容差的存在理由：语料随源码演进（新增文件会改变 BM25 竞争），故允许 ≤3 条查询（9.4pp）
 *    与 0.04 MRR 的抖动；超过即视为真实回归；
 * 4. 成本：索引 ~1.4s + 查询 ~0.16s（本机实测），可留在 `npm test` 里当门禁。
 *
 * 另：本文件顺带恢复了随评测子系统一起丢失的**锚点审计**（"锚点必须真的出现在语料里"）——
 * 否则锚点漂移会把"评测集坏了"读成"检索退步了"（`recallQueries.ts` 的文件头记过这个坑）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ContextEngine } from '../../src/context/contextEngine.js';
import { RECALL_QUERIES, CORE_RECALL_QUERIES } from '../fixtures/recallQueries.js';

/** 仓库根（编译产物在 `dist/tests/unit/`，故上溯三级）。 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** 取 Top-K 文件的 K（与基线夹具一致）。 */
const K = 14;

/** 入库基线（floor）。 */
interface RetrievalBaseline {
  readonly corpusFiles: number;
  readonly plain: { readonly recall: number; readonly mrr: number };
  readonly rerank: { readonly recall: number; readonly mrr: number };
  readonly _lens: { readonly tolerance: { readonly recallQueries: number; readonly mrr: number } };
}

/**
 * 读入库基线。
 * @returns 基线对象。
 */
function loadBaseline(): RetrievalBaseline {
  const raw = readFileSync(join(REPO_ROOT, 'tests/fixtures/retrievalBaseline.json'), 'utf8');
  return JSON.parse(raw) as RetrievalBaseline;
}

/** 一个镜头的测量结果。 */
interface LensResult {
  /** 命中查询数。 */
  readonly hits: number;
  /** 命中率。 */
  readonly recall: number;
  /** 首个命中位次倒数的均值。 */
  readonly mrr: number;
}

/**
 * 用指定镜头测量 32 条冻结查询。
 * @param corpus 已索引语料。
 * @param filesWith anchor → 含该字面量的文件集合（GT 定位）。
 * @param rerank 是否启用生产用的词法二段精排。
 * @returns 该镜头的 recall/MRR。
 */
function measure(
  corpus: ReturnType<typeof ContextEngine.indexCorpus>,
  filesWith: ReadonlyMap<string, readonly string[]>,
  rerank: boolean,
): LensResult {
  let hits = 0;
  let reciprocal = 0;
  for (const { q, anchor } of CORE_RECALL_QUERIES) {
    const gt = new Set(filesWith.get(anchor) ?? []);
    const result = ContextEngine.query(corpus, q, { rerank, fileK: K });
    const rank = result.files.findIndex((file) => gt.has(file));
    if (rank >= 0) {
      hits += 1;
      reciprocal += 1 / (rank + 1);
    }
  }
  const n = CORE_RECALL_QUERIES.length;
  return { hits, recall: hits / n, mrr: reciprocal / n };
}

/**
 * 建立 anchor → 文件集合（GT 定位）。
 *
 * 2026-10-05 扩到**全量**查询（原先只审计冻结 32 条——第五十三轮删掉 `SafeRemoveTree` 后
 * GROWTH 批次里它的 GT 变空，`tools/probes/recallHitrate.mjs` 当场抛错，而本文件的审计
 * 因只看 CORE 没拦住；锚点审计必须与评测集同口径，不能留盲区）。
 * @param corpus 已索引语料。
 * @returns 映射与"缺失锚点"列表。
 */
function anchorsOf(corpus: ReturnType<typeof ContextEngine.indexCorpus>): {
  readonly filesWith: Map<string, string[]>;
  readonly missing: readonly string[];
} {
  const filesWith = new Map<string, string[]>();
  for (const [rel, text] of corpus.fileText) {
    for (const { anchor } of RECALL_QUERIES) {
      if (text.includes(anchor)) {
        const list = filesWith.get(anchor) ?? [];
        list.push(rel);
        filesWith.set(anchor, list);
      }
    }
  }
  const missing = RECALL_QUERIES.filter((x) => !filesWith.has(x.anchor)).map((x) => x.anchor);
  return { filesWith, missing };
}

test('① 锚点审计：全量查询的 GT 锚点必须逐条出现在当前语料里（不只冻结 32 条）', () => {
  // 恢复随评测子系统丢失的审计：锚点漂移必须**归因到评测集**，不能被读成检索退步。
  const corpus = ContextEngine.indexCorpus(join(REPO_ROOT, 'src'), { light: true });
  const { missing } = anchorsOf(corpus);
  assert.deepStrictEqual(
    missing,
    [],
    `以下锚点已不在源码里（评测集漂移，先修锚点再谈召回）：${missing.join('、')}`,
  );
});

test('② 检索质量回归守卫：plain 与 rerank 两镜头的 recall@14 / MRR 均不得低于基线 − 容差', () => {
  const baseline = loadBaseline();
  const corpus = ContextEngine.indexCorpus(join(REPO_ROOT, 'src'), { light: true });
  const { filesWith, missing } = anchorsOf(corpus);
  assert.deepStrictEqual(missing, [], '锚点缺失时先修评测集（与 ① 同口径，避免召回被误判）');

  const plain = measure(corpus, filesWith, false);
  const rerank = measure(corpus, filesWith, true);
  const tolQueries = baseline._lens.tolerance.recallQueries;
  const tolMrr = baseline._lens.tolerance.mrr;
  const n = CORE_RECALL_QUERIES.length;

  // 证据行：门禁日志里要能直接看到口径与数字（否则红/绿都不可复核）。
  console.log(
    `[检索基线] 语料 ${String(corpus.files.length)} 文件 / ${String(corpus.symbols.length)} 符号；` +
      `K=${String(K)}；plain ${plain.hits}/${String(n)} recall=${(plain.recall * 100).toFixed(1)}% mrr=${plain.mrr.toFixed(4)}；` +
      `rerank ${rerank.hits}/${String(n)} recall=${(rerank.recall * 100).toFixed(1)}% mrr=${rerank.mrr.toFixed(4)}；` +
      `基线 plain ${(baseline.plain.recall * 100).toFixed(1)}% / rerank ${(baseline.rerank.recall * 100).toFixed(1)}%` +
      `（容差 ${String(tolQueries)} 条 / ${String(tolMrr)} MRR）`,
  );

  assert.ok(
    plain.hits >= baseline.plain.recall * n - tolQueries,
    `plain 镜头召回退步：${String(plain.hits)}/${String(n)}（基线 ${(baseline.plain.recall * n).toFixed(1)}，容差 ${String(tolQueries)} 条）`,
  );
  assert.ok(
    rerank.hits >= baseline.rerank.recall * n - tolQueries,
    `rerank 镜头召回退步：${String(rerank.hits)}/${String(n)}（基线 ${(baseline.rerank.recall * n).toFixed(1)}，容差 ${String(tolQueries)} 条）`,
  );
  assert.ok(
    plain.mrr >= baseline.plain.mrr - tolMrr,
    `plain 镜头 MRR 退步：${plain.mrr.toFixed(4)}（基线 ${baseline.plain.mrr}）`,
  );
  assert.ok(
    rerank.mrr >= baseline.rerank.mrr - tolMrr,
    `rerank 镜头 MRR 退步：${rerank.mrr.toFixed(4)}（基线 ${baseline.rerank.mrr}）`,
  );
});
