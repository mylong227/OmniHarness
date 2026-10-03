---
'@mylong227/omniharness': patch
---

**探针入库**：把行为判据从 gitignored 的 `.omniharness/` 搬进 `tools/probes/`（G21，P3 减法第三项）。

## 问题（报告 §1.5 的发现）

本仓此前的行为判据有 **26 个 `.mjs` 探针**躺在 **gitignored 的 `.omniharness/`** 里：GitHub 上不存在、
CI 不跑、别人复现不了。"**能被他人复现**"是判据可信的前提——只在作者本机存在的数字，等于没有判据。

## 改动

1. **新增 `tools/probes/`（入库、离线、确定性）**，首批三个探针：
   - `recallHitrate.mjs`（由 `.omniharness/recall-hitrate-probe.mjs` 提升）：生产口径 hitRate@K +
     **配对 bootstrap 95% CI**；语料 `src/`、查询 `tests/fixtures/recallQueries.ts`、GT 机械推出（无自证循环）。
   - `rerankDiscriminatorAb.mjs`（由 `rerank-discriminator-ab.mjs` 提升）：精排**判别器**受控对照，
     含两关统计（成对 bootstrap CI + repeated 2-fold 留出折）与**第二段净效果**判定。
   - `toolExposureBudget.mjs`（**新写**）：`ToolExposurePlanner` 的 `off`/`plan` 两模式下**直载工具数**
     ——报告点名的第三类（工具暴露）此前只有门禁没有数字形态，此探针补上。
2. **`tools/probes/README.md`**：复现配方（`npm ci` → `npm run build` → `node tools/probes/…`）、
   每个探针的「回答什么 / 口径 / 用法 / **实测参考值** / 诚实边界」、以及新增探针的 7 条约定。
3. **npm 脚本**：`probe:recall` / `probe:exposure` / `probe:rerank-ab`。

## 实测参考值（2026-10-03，本机；用于确认数量级一致）

| 探针                       | 数字                                                                                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recallHitrate --fileK=20` | 语料 926 文件 / 10,599 符号 / 192 查询；**all 40.6% [33.9, 47.4]**、**core 68.8% [53.1, 84.4]**、ext 35.0% [28.1, 42.5]                               |
| `toolExposureBudget`       | 工具总数 **46**；`plan` 模式 **20–46** 可见（均值 28.9）；**2/8 条任务不命中类别 ⇒ fail-safe 全放行 46**                                              |
| `rerankDiscriminatorAb 14` | 基线 V0 `hit@14 33.3% / recall 21.2% / MRR 0.130`；**全部判别器变体「不成立」（CI 跨 0 或折负）**；第二段净效果 `MRR ΔCI [−2.28, 2.27]pp`、折负 20/40 |

## 判据（`tests/unit/probesInRepo.test.ts`，6 例，离线零 key）

① 每个探针都在 README 登记（漏登记 = 别人不知道它存在）；② 四段头注释（回答什么/口径/前置/诚实边界）；
③ **可移植**：无绝对路径、不依赖 gitignored 的 `.omniharness/`；④ 缺编译产物时给出 `npm run build`
提示并以退出码 2 终止（不静默失败）；⑤ 支持 `--json=` 机器可读输出；⑥ **实跑自证**：真的跑一次
`toolExposureBudget.mjs` 并断言输出的结构与数值边界（"文件存在"不算数）。

**变异测试**：README 里改名一个探针 ⇒ ① 红；给探针塞 Windows 绝对路径 ⇒ ③ 红；让探针不再打印工具总数
⇒ ⑥ 红；回滚后 6/6 绿。

## 三类中"前缀 / 工具暴露"的处置（报告给的"或并入 G1"分支）

复核结果：**前缀复用**判据本就在仓库内（`tests/unit/prefixReuseGuard.test.ts`），**工具暴露**判据也在
（`tests/unit/toolExposurePlanner.test.ts`）——它们缺的不是"入库"，而是"**报数字**"的形态，故只补了
`toolExposureBudget.mjs`；前缀类的数字形态已由既有判据在 `--test` 输出里给出。

## 验证

`tsc --noEmit` 零错误；`npm test` 全绿（新 6 例）；三个探针均在本机实跑通过；
`node scripts/runGates.mjs --tier=all` 两层跑通；`api:check` / `rust:test` / `web:test` 全绿。

## 口径边界（如实登记）

- `toolExposureBudget` 量的是**工具数**，**不是** schema token 数（规划器看不到 schema）。工具数与
  schema 体积近似成正比，但探针**不声称**具体 token 节省比例；要 token 数需接真实 schema（登记为 G21-b）。
- 检索与精排探针的数字**随语料变化**（`src/` 每加文件都会影响召回）⇒ 跨提交比较必须同语料；
  README 里的参考值用于确认**数量级**一致，不是逐位相等。
- 其余 23 个 `.omniharness/*.mjs` 探针（Web UI / 诊断类）多为一次性事故排查脚本，**未**提升；
  如需再提升，按 README 的 7 条约定逐个搬。
