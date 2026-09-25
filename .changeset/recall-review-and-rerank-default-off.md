---
'omniharness': minor
---

检索评测集第二方复核收口 + 精排默认回关（opt-in）

- `tests/fixtures/recallQueries.ts` EXTENDED 51 条经第二方独立逐条复核（KEEP 43 / FIX_ANCHOR 4 / REPLACE_QUERY 4 / DROP 0）：4 处过泛锚点改为定义字面（`scanForInjection` / `class LineTransport` / `class AuditSink` / `class MemoryExtractor`），4 处答非所问的查询重写；修正后单测三不变量与 `recall-query-audit` 门禁复验通过，all84 命中画像 63.1%（冻结 core33 78.8% 不变）。
- `evals/rerank-ab.mjs` 退役内联 33 条，改接 fixture 全量 84 条（新增 core33 / extended51 分层增益与 querySource 口径）；复核后复跑：core33 +5.9pp / extended51 +0.4pp，基准档（K=14）点增益 +2.6pp 但 CI95 [−1.59, +7.59] 跨 0 ⇒ 两关未过。
- **行为变更**：按「CI 下界 > 0 才配当默认」纪律，`RepoMapContextEngine` 精排默认回关为 opt-in（`opts.rerank: true` 或 env `OMNI_RERANK=1` 显式开启）；`evals/production-defaults-check.mjs`（默认档/opt-in 双逐字对拍 + env 探针改向）与 `benchmark/swebench_predict.mjs`（复刻解析口径跟随生产默认）同步。core33 上 opt-in 仍 +9.1pp（78.8% vs 69.7%），深池场景建议显式开启。新增 `tests/unit/rerankDefault.test.ts` 三例行为钉（默认==关、env==开、产出可区分防死旋钮）。
