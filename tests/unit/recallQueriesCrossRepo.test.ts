/**
 * 跨仓库检索评测查询集（L3 证据层）的**结构与对抗性**校验（2026-09-27）。
 *
 * ## 为什么单测 + 仪器两层，而不是只留仪器
 *
 * 外部语料（`eval-data/repos/**`）**不入库**（`.gitignore` 整目录忽略）⇒ CI 里没有语料，
 * 「锚点 GT 非空 / 锚点出现文件数 ≤3」这类**必须读语料**的协议项只能在语料就位的机器上跑。
 * 但查询集本身的结构与对抗性**与语料无关**，若不在 CI 里钉住，就会重演仓内查询集的老问题：
 * 评测集悄悄退化（删条、重复、查询里写出锚点字面量）而无人发现。
 *
 * 故本测试只覆盖**零语料依赖**的三类不变量，毫秒级、可在 CI 当门禁：
 *   ① 注册结构：五仓齐全、字段非空、root 是仓内相对路径、查询文本全库唯一、锚点仓内唯一；
 *   ② 对抗性：查询内容词与锚点子词**零交集**（复用仓内 `adversarialOverlap` 单一真相来源）；
 *   ③ 路径词禁令（语料级代理）：查询内容词不得含**包目录名 / 仓名**词元（防「答案写在查询里」）。
 *
 * ## 2026-10-03 状态变更（跑分/评测子系统整体删除）
 *
 * `evals/`（含 `recall-crossrepo.mjs` / `semantic-crossrepo.mjs` / `crossrepo-anchor-probe.mjs`
 * 三份跨仓仪器）与 `eval-data/`（语料）已随跑分/评测子系统一并删除。因此：
 *  - 原「④ 单一真相来源：三份跨仓仪器都读本 fixture」**已删除**——它断言的对象不存在了，
 *    留着只会恒红；
 *  - 本测试现在只校验**夹具数据本身**（①②③），其 `root` 指向的 `eval-data/repos/**`
 *    已永久不存在（语料相关校验无处可跑，已随仪器消失）；
 *  - 保留理由：它是**测试数据**（查询集）而非评分设施。若确认不再需要跨仓检索语料，
 *    可把本文件、`fixtures/recallQueriesCrossRepo.ts` 一并删除。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CROSS_REPO_CORPORA } from '../fixtures/recallQueriesCrossRepo.js';
import { adversarialOverlap, contentTokensOf } from '../fixtures/recallQueries.js';

/** 每仓最少查询条数（当前均为 12；低于此值说明集合被静默削过）。 */
const MIN_QUERIES_PER_CORPUS = 12;

/**
 * `contentTokensOf` 把查询切成内容词；少于该数说明查询退化成关键词，度量不到「非字面检索」。
 * 取值 = 现集合实测最小值（60 条里仅 1 条为 4，其余 ≥6），故它拦的是**退化**而非现状。
 */
const MIN_CONTENT_TOKENS = 4;

test('① 注册结构：五仓齐全、字段非空、root 为仓内相对路径、查询文本全库唯一', () => {
  assert.ok(CROSS_REPO_CORPORA.length >= 5, `语料数仅 ${CROSS_REPO_CORPORA.length}（L3 需 ≥5）`);
  const seenQueries = new Map();
  for (const corpus of CROSS_REPO_CORPORA) {
    assert.ok(corpus.repo.trim() !== '', `空 repo：${JSON.stringify(corpus.repo)}`);
    assert.ok(corpus.root.trim() !== '', `${corpus.repo} 的 root 为空`);
    // root 必须是「仓内相对路径」：绝对路径 / 盘符 / 上跳都会让仪器在别的机器上读到别的东西。
    assert.ok(!corpus.root.startsWith('/'), `${corpus.repo} 的 root 是绝对路径：${corpus.root}`);
    assert.ok(!/^[A-Za-z]:/.test(corpus.root), `${corpus.repo} 的 root 带盘符：${corpus.root}`);
    assert.ok(!corpus.root.includes('..'), `${corpus.repo} 的 root 含上跳：${corpus.root}`);
    assert.ok(corpus.root.includes('/'), `${corpus.repo} 的 root 应是目录路径：${corpus.root}`);
    assert.ok(
      corpus.queries.length >= MIN_QUERIES_PER_CORPUS,
      `${corpus.repo} 仅 ${corpus.queries.length} 条（下限 ${MIN_QUERIES_PER_CORPUS}）`,
    );
    const anchors = new Set();
    for (const entry of corpus.queries) {
      assert.ok(entry.q.trim() !== '', `${corpus.repo} 有空查询`);
      assert.ok(entry.anchor.trim() !== '', `${corpus.repo} 有空锚点（查询：${entry.q}）`);
      assert.ok(
        contentTokensOf(entry.q).size >= MIN_CONTENT_TOKENS,
        `${corpus.repo} 查询内容词过少（<${MIN_CONTENT_TOKENS}）：${entry.q}`,
      );
      const owner = seenQueries.get(entry.q);
      assert.strictEqual(
        owner,
        undefined,
        `查询文本重复（${owner} 与 ${corpus.repo}）：${entry.q}`,
      );
      seenQueries.set(entry.q, corpus.repo);
      assert.ok(!anchors.has(entry.anchor), `${corpus.repo} 锚点重复：${entry.anchor}`);
      anchors.add(entry.anchor);
    }
  }
  // 规模门槛：把「静默删条」变成红。当前 5 仓 × 12 = 60。
  assert.ok(
    seenQueries.size >= CROSS_REPO_CORPORA.length * MIN_QUERIES_PER_CORPUS,
    `查询总数仅 ${seenQueries.size}`,
  );
});

test('② 对抗性：全部条目的查询内容词与锚点子词零交集', () => {
  for (const corpus of CROSS_REPO_CORPORA) {
    for (const entry of corpus.queries) {
      const overlap = adversarialOverlap(entry);
      assert.deepStrictEqual(
        overlap,
        [],
        `${corpus.repo}：查询「${entry.q}」与锚点「${entry.anchor}」字面重合：${overlap.join(', ')}`,
      );
    }
  }
});

test('③ 路径词禁令（离线代理）：查询不得含包目录名 / 仓名词元', () => {
  for (const corpus of CROSS_REPO_CORPORA) {
    const packageDir = corpus.root.split('/').pop() ?? '';
    const shortName = corpus.repo.split('/').pop() ?? '';
    const forbidden = new Set([
      ...contentTokensOf(packageDir.replace(/_/g, ' ')),
      ...contentTokensOf(shortName),
    ]);
    assert.ok(forbidden.size > 0, `${corpus.repo}：未能从 root/仓名解析出任何禁止词元`);
    for (const entry of corpus.queries) {
      for (const token of contentTokensOf(entry.q)) {
        assert.ok(
          !forbidden.has(token),
          `${corpus.repo}：查询含语料自身名词「${token}」（包目录 ${packageDir}）：${entry.q}`,
        );
      }
    }
  }
});
