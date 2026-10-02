#!/usr/bin/env node
// LSP 候选源**第 2 关 A/B**（Gate-2）——裁定「LSP 引用/定义扩展候选」是否真的提升召回。
//
// ## 为什么必须有这个脚本（而不是只看 probe 的数字）
//
// `evals/probe-lsp-candidates.mjs` 只证明了「真实子进程 LSP 往返可用」（5/5 成功、26–89ms），
// 并如实登记「每查询只扩展出 1–3 个文件」——但**「能产出候选」不等于「提升召回」**。
// 本仓已有血案：层化图路由第 1 关（查询敏感度 0.038，比 BM25 还「查询专属」）**放行**，
// 第 2 关实测 **−9.1pp**。即「每次给不同的文件」与「每次给对的文件」是两回事。
// 故本脚本直接做**第 2 关**，判据与 `evals/rerank-ab.mjs` 同一套（本仓「两关」纪律）：
//
//   · 接线活性：两臂上下文必须存在差异，否则说明 LSP 被静默旁路（`changedQueries === 0` 即红）；
//   · CI 下界 > 0（按查询配对 bootstrap，种子固定，`Bootstrap.bootstrapInterval`）；
//   · 留出折多数为正（repeated 2-fold × 20，单点击穿的增益过不了这一关）。
//
// ## 两臂是什么（开关隔离，同 corpus、同 fileK、同查询）
//
//   A（基线） `RepoMapContextEngine.getRepoMapContext(root, q, {fileK})`            —— 生产同步纯 BM25 路径
//   B（候选） `RepoMapContextEngine.getRepoMapContextWithLsp(root, q, lsp, {fileK})` —— 同一引擎 + LSP 扩展候选
//
// 两臂共用**同一个引擎实例与同一份语料**，唯一变量就是「有没有走 LSP 扩展」——这正是
// `docs/RECALL_HEADROOM_SURVEY.md` §11 要求的「同 corpus、开关隔离 + bootstrap CI」。
//
// ## 诚实边界（先写在前面，避免报告被过度引用）
//
//  - 判据是**检索命中率**（GT 文件是否进 top-K），**不是任务成功率**；命中率≠解题率是本仓已登记的结论。
//  - 查询集是 `tests/fixtures/recallQueries.ts`（自然语言改写、刻意避开锚点字面词）⇒ **对抗口径**。
//    自然口径下检索已近饱和（97%），那类查询给不出区分度。
//  - 依赖真实语言服务器（`npx --yes typescript-language-server --stdio`，可用 `OMNI_LSP_SERVER`
//    覆盖）。**故本脚本不进 `eval:ci`**——与 `eval:lsp-probe` 同纪律，否则会 flaky。
//  - 若本机无语言服务器 ⇒ 干净 SKIP（非失败），并落 `status:'SKIP'` 报告；这**不是**「增益为零」的证据。
//
// 用法：
//   node evals/lsp-recall-ab.mjs [--filek 14,20] [--seed-limit 8] [--timeout 2000] [--gate]
// 产物：evals/lsp-recall-ab.report.json
// 免网络（语言服务器已在 npx 缓存时）、免模型、免 API key。

import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist', 'src');
const REPORT = join(__dirname, 'lsp-recall-ab.report.json');
// Windows 下绝对路径必须是合法 file:// URL（直接 new URL('D:/...') 会抛 ERR_UNSUPPORTED_ESM_URL_SCHEME）。
const importDist = (...s) => import(pathToFileURL(join(DIST, ...s)).href);

const GATE = process.argv.includes('--gate');
/** 取值型参数（`--name value`）。 */
const argOf = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
};

const FILE_KS = String(argOf('--filek', '14,20'))
  .split(',')
  .map((x) => Number(x.trim()))
  .filter((x) => Number.isFinite(x) && x > 0);
/** 判定基准档：与 `rerank-ab.mjs` 的范式档一致（`docs/POLISH_PLAN.md` P1 的验收口径）。 */
const DECISION_FILE_K = 14;
const SEED_LIMIT = Number(argOf('--seed-limit', '8'));
const PER_CALL_TIMEOUT_MS = Number(argOf('--timeout', '2000'));
const BOOT_ROUNDS = 2000;
const BOOT_SEED = 0x5eed1e;

/** 解析语言服务器命令：`OMNI_LSP_SERVER` > 默认 typescript-language-server。 */
const rawServer = process.env.OMNI_LSP_SERVER ?? 'npx --yes typescript-language-server --stdio';
const [serverCommand, ...serverArgs] = rawServer.split(/\s+/);

/** 探测服务器是否可达（跨平台：直接跑 `--version`，只有 ENOENT 才算不可达）。 */
function serverReachable() {
  const probe = spawnSync(
    serverCommand,
    [...serverArgs.filter((a) => a !== '--stdio'), '--version'],
    {
      stdio: 'ignore',
      shell: true,
    },
  );
  return probe.error === undefined;
}

const writeReport = (report) => {
  writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log(`\nWrote evals/lsp-recall-ab.report.json`);
};

const skip = (reason) => {
  const report = {
    eval: 'lsp-recall-ab',
    status: 'SKIP',
    reason,
    serverCommand,
    serverArgs,
    at: new Date().toISOString(),
  };
  writeReport(report);
  console.log(`[lsp-recall-ab] SKIP: ${reason}`);
};

const main = async () => {
  if (!serverReachable()) {
    // 未具备生产前提 ⇒ 干净 SKIP。**刻意不退出 1**：这不是「增益为零」的证据，
    // 把它记成红会把「没装服务器」误读成「LSP 无效」。
    skip(`未检测到语言服务器「${serverCommand}」；用 OMNI_LSP_SERVER 显式指定后重跑。`);
    return;
  }

  const { ContextEngine } = await importDist('context', 'contextEngine.js');
  const { RepoMapContextEngine } = await importDist(
    'context',
    'repoMap',
    'repoMapContextEngine.js',
  );
  const { LspProcessAdapter } = await importDist('adapters', 'lsp', 'lspProcessAdapter.js');
  const { Bootstrap } = await importDist('evolution', 'bootstrap.js');
  const { RECALL_QUERIES } = await import(
    new URL('../dist/tests/fixtures/recallQueries.js', import.meta.url).href
  );

  const SRC = join(ROOT, 'src');
  const corpus = ContextEngine.indexCorpus(SRC, { morph: true, light: true });
  console.log(`语料：${corpus.files.length} 文件 / ${corpus.symbols.length} 符号`);

  /** GT：锚点字面出现在哪些文件里（与 rerank-ab / chunk-recall-ab 同口径）。 */
  const groundTruth = (anchor) => {
    const needle = anchor.toLowerCase();
    const set = new Set();
    for (const [rel, text] of corpus.fileText) {
      if (text.toLowerCase().includes(needle)) set.add(rel);
    }
    return set;
  };

  // ── 查询集：锚点失效（GT=0）会白送 100% 召回 ⇒ 跳过并记账（不静默吞、不崩溃）────────
  const items = [];
  const skipped = [];
  for (const entry of RECALL_QUERIES) {
    const gt = groundTruth(entry.anchor);
    if (gt.size === 0) {
      skipped.push({ q: entry.q, anchor: entry.anchor, reason: 'GT=0：锚点在语料中不存在' });
      continue;
    }
    items.push({ q: entry.q, anchor: entry.anchor, gt });
  }
  const n = items.length;
  console.log(`有效查询：${n}/${RECALL_QUERIES.length}（跳过 ${skipped.length}）`);
  if (n === 0) {
    skip('有效查询为 0（全部锚点失效）——查询集与语料不匹配。');
    return;
  }

  // ── 候选池天花板（诊断）：GT 文件在纯 BM25 的**未截断池**里最浅能排到第几 ──────────
  // 这条诊断决定了「LSP 到底有没有机会」：若 GT 文件**根本不在池内**，LSP 补 1–3 个文件
  // 也只可能补到其中一部分；若 GT 已在池内但排在 K 之外，LSP 的作用是「提权」而非「发现」。
  const CEILING_KS = [10, 14, 20, 30, 50];
  const ceiling = {
    byK: {},
    avgPoolSize: 0,
    unreachable: 0,
    bestRank: { le14: 0, le20: 0, le30: 0, le50: 0 },
  };
  {
    const pools = [];
    for (const it of items) {
      const res = ContextEngine.query(corpus, it.q, { fileK: 400, symK: 24 });
      pools.push(res.files.length);
      const rankOf = new Map(res.files.map((f, i) => [f, i + 1]));
      let best = Number.POSITIVE_INFINITY;
      for (const f of it.gt) {
        const r = rankOf.get(f);
        if (r !== undefined && r < best) best = r;
      }
      if (best === Number.POSITIVE_INFINITY) ceiling.unreachable += 1;
      for (const k of CEILING_KS) {
        const top = new Set(res.files.slice(0, k));
        (ceiling.byK[k] ??= []).push([...it.gt].filter((f) => top.has(f)).length / it.gt.size);
      }
      if (best <= 14) ceiling.bestRank.le14 += 1;
      if (best <= 20) ceiling.bestRank.le20 += 1;
      if (best <= 30) ceiling.bestRank.le30 += 1;
      if (best <= 50) ceiling.bestRank.le50 += 1;
    }
    const avg = (xs) => (xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length);
    ceiling.avgPoolSize = +avg(pools).toFixed(1);
    ceiling.recallAtK = Object.fromEntries(
      CEILING_KS.map((k) => [k, +((avg(ceiling.byK[k]) ?? 0) * 100).toFixed(1)]),
    );
    console.log(
      `候选池天花板：平均池 ${ceiling.avgPoolSize} 文件；召回@K ${CEILING_KS.map((k) => `${k}=${ceiling.recallAtK[k]}%`).join(' ')}；池内不可达 ${ceiling.unreachable}/${n}`,
    );
  }

  // ── LSP 服务器生命周期：一次拉起，两臂共用（避免把启动成本算进查询延迟）──────────
  const rootUri = pathToFileURL(ROOT).href;
  const adapter = new LspProcessAdapter(
    { serverCommand, serverArgs, rootUri },
    { diagnosticsTimeoutMs: 5000 },
  );
  const engine = new RepoMapContextEngine();
  const started = Date.now();
  try {
    // 健康探针：先发一次 references 确认服务器能 initialize 并应答（失败即整体不可达）。
    const probeFile = join(SRC, 'context', 'lspCandidateSource.ts');
    await adapter.references(probeFile, 1, 1);
  } catch (error) {
    await adapter.shutdown().catch(() => {});
    skip(
      `语言服务器 initialize/首次应答失败：${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  const warmupMs = Date.now() - started;
  console.log(`LSP 服务器就绪：${serverCommand}（预热 ${warmupMs}ms）`);

  /** 从上下文文本里抽出「被呈现的文件」——与 rerank-ab 的 `surfacedFiles` 同口径。 */
  const surfacedFiles = (context) => {
    const files = new Set();
    if (!context) return files;
    for (const line of context.split('\n')) {
      const m = line.match(/📄\s+(.+)/);
      if (m) files.add(m[1].trim());
    }
    return files;
  };
  const recallOf = (gt, surfaced) =>
    gt.size === 0 ? 0 : [...gt].filter((f) => surfaced.has(f)).length / gt.size;
  const precisionOf = (gt, surfaced) =>
    surfaced.size === 0 ? 0 : [...gt].filter((f) => surfaced.has(f)).length / surfaced.size;
  const avg = (xs) => (xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length);
  const pct = (x) => +(x * 100).toFixed(1);

  /** 稳健性：种子化 bootstrap CI + repeated 2-fold × 20（与 rerank-ab 逐字同法）。 */
  const robustnessOf = (gains) => {
    const ci = Bootstrap.bootstrapInterval(gains, (rs) => avg(rs), {
      rounds: BOOT_ROUNDS,
      seed: BOOT_SEED,
    });
    let seed = 0x9e3779b9;
    const rnd = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const folds = [];
    for (let rep = 0; rep < 20; rep += 1) {
      const idx = gains.map((_, i) => i);
      for (let i = idx.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rnd() * (i + 1));
        [idx[i], idx[j]] = [idx[j], idx[i]];
      }
      const half = Math.floor(idx.length / 2);
      folds.push(avg(idx.slice(0, half).map((i) => gains[i])));
      folds.push(avg(idx.slice(half).map((i) => gains[i])));
    }
    const negative = folds.filter((f) => f < 0).length;
    return {
      pointPp: +avg(gains).toFixed(2),
      ciLoPp: +ci.lo.toFixed(2),
      ciHiPp: +ci.hi.toFixed(2),
      rounds: ci.rounds,
      folds: folds.length,
      foldMeanPp: +avg(folds).toFixed(2),
      foldMinPp: +Math.min(...folds).toFixed(2),
      foldMaxPp: +Math.max(...folds).toFixed(2),
      negativeFolds: negative,
    };
  };

  // ── 逐档 AB ──────────────────────────────────────────────────────────────────
  const perFileK = [];
  const gateFailures = [];
  for (const fileK of FILE_KS) {
    const offRecalls = [];
    const onRecalls = [];
    const offPrecs = [];
    const onPrecs = [];
    const rows = [];
    const lspLatencies = [];
    let changed = 0;
    /** LSP 路补进来的、且**真的进了最终 top-K** 的文件数（判断 LSP 是否被排序淹没）。 */
    let lspTopKFiles = 0;

    for (const it of items) {
      const offCtx = engine.getRepoMapContext(SRC, it.q, { fileK });
      const t0 = Date.now();
      const onCtx = await engine.getRepoMapContextWithLsp(
        SRC,
        it.q,
        adapter,
        { fileK },
        { seedLimit: SEED_LIMIT, perCallTimeoutMs: PER_CALL_TIMEOUT_MS },
      );
      lspLatencies.push(Date.now() - t0);

      const off = surfacedFiles(offCtx);
      const on = surfacedFiles(onCtx);
      const offRecall = recallOf(it.gt, off);
      const onRecall = recallOf(it.gt, on);
      const offPrec = precisionOf(it.gt, off);
      const onPrec = precisionOf(it.gt, on);
      offRecalls.push(offRecall);
      onRecalls.push(onRecall);
      offPrecs.push(offPrec);
      onPrecs.push(onPrec);

      // 接线活性：文本必须真的变了（否则 LSP 被静默旁路）。
      const isChanged = offCtx !== onCtx;
      if (isChanged) changed += 1;
      const added = [...on].filter((f) => !off.has(f));
      const removed = [...off].filter((f) => !on.has(f));
      lspTopKFiles += added.filter((f) => it.gt.has(f)).length;

      rows.push({
        q: it.q,
        anchor: it.anchor,
        offRecall: +offRecall.toFixed(4),
        onRecall: +onRecall.toFixed(4),
        deltaPp: +((onRecall - offRecall) * 100).toFixed(1),
        offSurfaced: off.size,
        onSurfaced: on.size,
        addedTopK: added.length,
        removedTopK: removed.length,
        changed: isChanged,
      });
    }

    const offRecall = avg(offRecalls);
    const onRecall = avg(onRecalls);
    const offPrec = avg(offPrecs);
    const onPrec = avg(onPrecs);
    const gains = rows.map((r) => (r.onRecall - r.offRecall) * 100);
    const rob = robustnessOf(gains);
    const up = rows.filter((r) => r.deltaPp > 0).length;
    const down = rows.filter((r) => r.deltaPp < 0).length;
    const flat = n - up - down;
    const sortedLatency = [...lspLatencies].sort((a, b) => a - b);

    const wiringOk = changed > 0;
    const decisive = fileK === DECISION_FILE_K;
    const ciOk = rob.ciLoPp > 0;
    const foldsOk = rob.foldMeanPp > 0 && rob.negativeFolds < rob.folds / 2;
    const passedAll = wiringOk && ciOk && foldsOk;
    const passed = wiringOk && (!decisive || (ciOk && foldsOk));

    console.log(`\n=== fileK=${fileK}${decisive ? '（判定基准档）' : '（仅登记）'} ===`);
    console.log(`  召回  基线 ${pct(offRecall)}% → +LSP ${pct(onRecall)}%（Δ ${rob.pointPp}pp）`);
    console.log(`  精度  基线 ${pct(offPrec)}% → +LSP ${pct(onPrec)}%`);
    console.log(`  单查询分布  提升 ${up} / 持平 ${flat} / 下降 ${down}`);
    console.log(
      `  CI95 [${rob.ciLoPp}, ${rob.ciHiPp}]pp  留出折 负 ${rob.negativeFolds}/${rob.folds}（min ${rob.foldMinPp}pp）`,
    );
    console.log(
      `  接线活性：${changed}/${n} 条上下文发生改变；LSP 补入 top-K 的 GT 文件合计 ${lspTopKFiles} 个`,
    );
    console.log(
      `  LSP 延迟：p50 ${sortedLatency[Math.floor(0.5 * sortedLatency.length)]}ms / p90 ${sortedLatency[Math.floor(0.9 * sortedLatency.length)]}ms / max ${sortedLatency[sortedLatency.length - 1]}ms`,
    );
    console.log(
      `  第二关（CI 下界 > 0 且留出折多数为正）：${ciOk ? '过' : `未过（CI 下界 ${rob.ciLoPp}pp）`} / ${foldsOk ? '过' : `未过（${rob.negativeFolds}/${rob.folds} 为负）`}`,
    );
    if (!passed) {
      gateFailures.push(
        `fileK=${fileK}: ${[
          wiringOk ? null : '接线未生效（两臂上下文逐字相同）',
          ciOk ? null : `CI 下界 ${rob.ciLoPp}pp ≤ 0`,
          foldsOk ? null : `留出折 ${rob.negativeFolds}/${rob.folds} 为负（多数口径）`,
        ]
          .filter((x) => x !== null)
          .join('；')}`,
      );
    }

    perFileK.push({
      fileK,
      decisive,
      passedAll,
      passed,
      recall: { off: pct(offRecall), on: pct(onRecall), deltaPp: rob.pointPp },
      precision: {
        off: pct(offPrec),
        on: pct(onPrec),
        deltaPp: +(onPrec * 100 - offPrec * 100).toFixed(1),
      },
      distribution: { up, flat, down },
      robustness: rob,
      wiring: { changedQueries: changed, totalQueries: n, ok: wiringOk, lspTopKFiles },
      latencyMs: {
        p50: sortedLatency[Math.floor(0.5 * sortedLatency.length)] ?? 0,
        p90: sortedLatency[Math.floor(0.9 * sortedLatency.length)] ?? 0,
        max: sortedLatency[sortedLatency.length - 1] ?? 0,
      },
      rows,
    });
  }

  await adapter.shutdown().catch(() => {});

  const decisiveRow = perFileK.find((x) => x.decisive);
  const lspServerVersion = (() => {
    const probe = spawnSync(
      serverCommand,
      [...serverArgs.filter((a) => a !== '--stdio'), '--version'],
      {
        encoding: 'utf8',
        shell: true,
      },
    );
    return typeof probe.stdout === 'string' ? probe.stdout.trim() : '';
  })();

  const report = {
    eval: 'lsp-recall-ab',
    status: 'DONE',
    decidedAt: new Date().toISOString(),
    path: 'production engine method: RepoMapContextEngine.getRepoMapContextWithLsp（arm B） vs getRepoMapContext（arm A）',
    querySource: 'tests/fixtures/recallQueries.ts',
    decisionFileK: DECISION_FILE_K,
    decisionBasis:
      'CI 下界 > 0 且留出折为正（docs/POLISH_PLAN.md P1，与 evals/rerank-ab.mjs 同一套「两关」纪律）；' +
      '在范式档 fileK=14 上判定，其余档位如实登记但不参与判定。',
    lspServer: { command: serverCommand, args: serverArgs, version: lspServerVersion, warmupMs },
    config: {
      fileKs: FILE_KS,
      seedLimit: SEED_LIMIT,
      perCallTimeoutMs: PER_CALL_TIMEOUT_MS,
      bootRounds: BOOT_ROUNDS,
      bootSeed: BOOT_SEED,
    },
    corpus: {
      root: 'src',
      files: corpus.files.length,
      symbols: corpus.symbols.length,
      light: true,
    },
    queryCount: n,
    skipped,
    ceiling,
    verdict: {
      lspPassesAtDecisionFileK: decisiveRow?.passed === true,
      // LSP 路至今**未接生产**（引擎方法零调用点、无 env 开关）；本报告只裁定「值不值得接」。
      wiredIntoProduction: false,
      note:
        '本脚本判据是**检索命中率**而非任务成功率。probe 实测每查询只扩展 1–3 个文件，' +
        '叠加本仓已登记的多次「扩大候选源对本语料无效」，预期结论偏中性或负；报告如实落盘，不预设结论。',
    },
    perFileK,
  };
  writeReport(report);

  if (GATE) {
    if (gateFailures.length > 0) {
      console.log('\n=== --gate 判定：FAIL ===');
      for (const f of gateFailures) console.log(`  ✗ ${f}`);
      process.exitCode = 1;
    } else {
      console.log(
        `\n=== --gate 判定：PASS（基准档 fileK=${DECISION_FILE_K}：${decisiveRow.recall.off}% → ${decisiveRow.recall.on}%，+${decisiveRow.recall.deltaPp}pp；接线活性 ${decisiveRow.wiring.changedQueries}/${n}）===`,
      );
    }
  }
};

main().catch((error) => {
  const report = {
    eval: 'lsp-recall-ab',
    status: 'ERROR',
    reason: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error),
    at: new Date().toISOString(),
  };
  writeReport(report);
  console.error(`[lsp-recall-ab] ERROR: ${report.reason}`);
  process.exitCode = 1;
});
