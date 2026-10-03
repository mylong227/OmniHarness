---
'@mylong227/omniharness': patch
---

**门禁按「是否需要类型」分层**：类型感知层独立成层 + 耗时预算实测断言（G27，TS3）。

## 问题

门禁此前是**一锅粥**：`eslint .` 根本**不含类型信息**（配置里没有 `parserOptions.project`），
所有自研脚本（架构 / 接线 / 死链 / 铁律…）也都是 AST/文本级——于是"只有类型系统看得见"的那类缺陷
（悬空 Promise、对非 Promise `await`、Promise 用错位置）**没有任何门禁在看**；而一旦想加，
又会因为类型感知 eslint 要为每个文件建 TS 程序而**拖慢提交**，于是迟迟没人加。

## 改动

1. **门禁声明分层**：`scripts/runGates.mjs` 每条门禁新增 `tier`（`fast` / `typed`），
   并支持 `--tier=fast|typed|all`（缺省 `fast` ⇒ pre-commit 行为与耗时不变）。
   `fast` = 无需类型信息（自研脚本 + 无 `project` 的 `eslint .`）；`typed` = 需要类型信息。
2. **类型感知层**：新增 `eslint.typed.config.mjs`（`parserOptions.project`，作用域 `src/**`），
   启用三条**必须类型才判得了**且存量为零的规则：`no-floating-promises`、`await-thenable`、
   `no-misused-promises`。两条 `typed` 门禁 `tsc` 与 `eslint-typed` 落在类型层。
3. **预算门禁**：新增 `scripts/gateBudget.mjs` + 无副作用的策略模块 `scripts/gateBudgetPolicy.mjs`，
   实测并断言两条预算（快层 `eslint .` < 65 s；类型层墙钟 ≤ 45 s），超预算即 exit 1 并**打印各项秒数**。
4. 新增 npm 脚本：`gate:typed` / `lint:typed` / `gate:budget`。

## 判据

- **结构判据**（`tests/unit/gateTiering.test.ts`，7 例，秒级、离线零 key）：①每条门禁都声明 tier
  且取值合法 ②类型层**只**含 `tsc` + `eslint-typed` ③快层不得混入类型层门禁 ④类型层**确实**给了
  `parserOptions.project`（否则 typed 规则**静默空转**）⑤类型层规则集**逐字**等于策略清单
  ⑥预算常量即报告口径且**只有一份** ⑦基础配置不含类型信息（快层快的前提）。
  **变异**：去掉 `project` ⇒ ④⑤ 变红；抹掉某条门禁的 `tier` ⇒ ①③ 变红；回滚后 7/7 绿。
- **耗时判据**（`npm run gate:budget` 实测）：`eslint .` **26.2 s**（预算 < 65 s）；
  类型层墙钟 **32.2 s**（预算 ≤ 45 s）⇒ 通过。

## 口径变更（如实登记，不隐藏）

报告初稿的判据是"`tsc`(17.0s) + typed eslint(23.1s) **之和** ≤ 45 s"。本机反复实测发现该"和"
**对机器负载过敏**：同一份代码空载 43.9 s、负载下 49.5 s / 55.5 s；而开发者**实际等待的是墙钟**——
两项**并发**跑，墙钟稳定 ~32 s。故预算改为按墙钟断言（≤45 s），同时把"和"的值一并打印供对照。
这条变更已同步进 `docs/CODE_STANDARD.md` §7.1（含 §7 的命令清单）。

## 验证

`tsc --noEmit` 零错误；`npm test` 全绿（新 7 例）；`npm run gate:typed` 全绿（41.6 s 墙钟，顺序跑）；
`npm run gate:budget` 通过；`arch:gate` / `check --strict` / `lint`（0 告警）/ `audit:config-wiring` /
`audit:maturity` / `check:doc-links` / `api:check` / `audit:standard:delta` / `rust:test` / `web:test` 全绿。
