---
'@mylong227/omniharness': patch
---

**文档瘦身**：`docs/` 根从 33 份收敛到 13 份，历史材料移入 `archive/` 并逐份加归档横幅；死链基线 96 → 24（G20，P3 减法第二项）。

## 问题

`docs/` 根堆了 **33 份** md：旧审计、旧计划、旧调研与现行纪律混在一起。后果是**旧数字被当现状**——
最典型的一例：`ARCHITECTURE_SPEC.md` 自述"311 TS 文件 / 31500 行"，而当时全仓已 **900+ 文件**。
索引本身也在失效：`docs/README.md` 与机器可读索引 `docs/llms.txt` 都指向十来个已归档/已删文档。

## 改动

1. **只留 SSOT + 现行纪律 + 用户文档**（13 份根级文档）：`PROJECT_BOARD`、`ARCHITECTURE_UPGRADE_2026-10`、
   `CODE_STANDARD`、`DEPENDENCY_POLICY`、`API_STABILITY`、`PORTS_CONTRACT`、`README`、`QUICKSTART`、
   `PLUGIN_GUIDE`、`contributing`、`integration`、`protocol`、`DOMAIN_SLICE_TEMPLATE`。
2. **20 份根级历史文档 + `library/`(9) + `agent_evolution_research/`(6) 移入 `docs/archive/`**
   （`git mv`，保留历史），归档总数 **55 份**。
3. **逐份加归档横幅**（55 份，含原有 19 份无横幅的）：写明"已归档（日期）／数字与结论**不再代表现状**"
   并指向现行 SSOT 与纪律——把"这是历史"写在**文件自身**里，单独转发也丢不掉。
4. **重写 `docs/README.md`**（现行索引：按角色选路径 + 旗帜文档 + 参考手册 + ADR + 归档入口 + 7 条治理规则）、
   **重写 `docs/llms.txt`**（机器可读索引只列现行入口）、**新增 `docs/archive/README.md`**
   （归档策略 + 55 份清单 + 治理规则，清单由脚本生成避免手抄错）。
5. **引用改写**：38 个文件里的 `docs/<name>` → `docs/archive/<name>`（含源码 JSDoc 里的措辞边界引用）。
6. **死链基线收紧 96 → 24 处**：迁移使归档文件内的死链键名整体移位（它们本就在基线里，指向已删除的
   评测子系统）。按门禁自己的出口（"确为迁移前路径…说明理由后 `--update`"）重写基线——**净减 72 处**，
   而非把新死链藏进基线。

## 判据（`tests/unit/docsLayout.test.ts`，6 例，离线零 key）

① `docs/` 根只允许白名单内文档（新增根级文档必须显式决定去向，且白名单不得列不存在的文件）；
② `archive/**` 每份文档必须带归档横幅（外加"归档数 > 40"的防回退下限）；③ 归档索引完整（不许孤儿）；
④ **现行索引自洽**：`docs/README.md` 与 `llms.txt` 的每个 `.md` 链接必须指向真实文件；
⑤ 现行文档不得用旧路径引用归档物（必须带 `archive/` 前缀）；⑥ 横幅内容含日期 + SSOT 指向 + "不再代表现状"。

**变异测试**：往 `docs/` 根丢野生文档 ⇒ ① 红；抹掉一份归档横幅 ⇒ ② 红；索引指向不存在文件 ⇒ ④ 红；
回滚后 6/6 绿。

## 验证

`tsc --noEmit` 零错误；`npm test` 全绿（新 6 例）；`check:doc-links` **新增 0**（基线 24）；
`node scripts/runGates.mjs --tier=all` 两层跑通；`api:check` / `rust:test` / `web:test` 全绿。

## 口径边界（如实登记）

- 归档**不删内容**：负结果与旧数字是证据（"失败的照实记"是本仓纪律），删掉会让后来者重复踩坑。
  归档解决的是另一个问题——别让旧数字被当成现状。
- `ARCHITECTURE_SPEC.md`（工程架构说明书）**整体归档**而非逐条更新：它的数字需以当前实测重写，
  而现行架构事实已在 `ARCHITECTURE_UPGRADE_2026-10.md` §2 与 `adr/`、`PORTS_CONTRACT.md` 中，
  重写它是另一件事（登记为 G20-b：若要恢复"架构说明书"这一形式上层的现行文档，需按现状重写一遍）。
