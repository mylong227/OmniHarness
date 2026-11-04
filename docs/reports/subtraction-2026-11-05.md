# 减法证据表：AGUI 协议簇（2026-11-05，P5 首批）

> PLAN_2026-11.md P5 纪律：每批删除附**调用方证据表**（文件 → grep 到的调用方 → 判定）；
> 单批 ≤ 5k 行；本批 1,646 + 508（判据）= 2,154 行 ✅。可 revert 的原子提交。

## 1. 批次范围

`src/protocols/agui/**` 全簇 8 文件（1,646 行）+ 其专测 `tests/unit/agui.test.ts`（508 行 / 19 例）。

## 2. 调用方证据表（逐文件）

| 文件                      | 行数 | grep 到的生产调用方                                                                                             | 判定         |
| ------------------------- | ---- | --------------------------------------------------------------------------------------------------------------- | ------------ |
| `aguiProtocol.ts`         | 393  | 簇外：**0**（`grep -rln agui src --include='*.ts'` 排除簇内后为空，实测）                                       | 无生产调用方 |
| `aguiEventMapper.ts`      | 392  | 簇外：0                                                                                                         | 无生产调用方 |
| `aguiHttpServer.ts`       | 309  | 簇外：0；`src/index.ts` / `src/indexBeta.ts` 均 **不** re-export 本簇（deadCode 图实测：从 4 个生产入口不可达） | 无生产调用方 |
| `aguiActivityMapper.ts`   | 168  | 簇外：0                                                                                                         | 无生产调用方 |
| `aguiJsonPatch.ts`        | 141  | 簇外：0                                                                                                         | 无生产调用方 |
| `aguiEventStream.ts`      | 106  | 簇外：0                                                                                                         | 无生产调用方 |
| `aguiStateMapper.ts`      | 91   | 簇外：0                                                                                                         | 无生产调用方 |
| `index.ts`（barrel）      | 46   | 簇外：0——barrel 本身无人 import（各处直接引深路径的形态也不存在）                                               | 无生产调用方 |
| `tests/unit/agui.test.ts` | 508  | 被删对象自身（专测死代码的判据不构成"活着"的理由——它养着的正是死代码）                                          | 随簇同删     |

机器判定交叉验证：`scripts/deadCode.mjs`（§212 门禁）把本簇 8 文件全部列为死模块候选并已冻结基线；
web/src 零引用（grep 实测）；desktop 无引用。

## 3. 为什么整簇是死的（背景）

AG-UI 适配（agent ↔ 用户界面事件层）按 `PROTOCOL_ECOSYSTEM.md` 规划实现于 2026-10-28 前后，
但**从未接线**：无 CLI 子命令挂载 `aguiHttpServer`、无 serve 装配引用、公共 API 门面
（`index.ts` / `indexBeta.ts`）不导出——与 ACP（编辑器连接层，已挂载）、A2A（agent 互操作，
已挂载）不同，AG-UI 是「规划三协议」中唯一只完成了实现、没完成装配的一条。

## 4. 影响与同步动作

- `docs/PROTOCOL_ECOSYSTEM.md`（**活文档**）：AG-UI 节加状态横幅（已移除 + 指回本证据表）；
  历史快照文档（`CORE_CAPABILITY_UPGRADE_2026-10-28.md`、`KERNEL_SPLIT_2026-11.md` 的行数盘点）
  **不改写历史数字**，由看板 §215 与本表记录变更。
- `scripts/deadCodeBaseline.json`：8 个条目随删除清偿（24 → 16），`--update` 收紧。
- 覆盖率基线中的 agui 条目：随删除后的全量 coverage `--dump-baseline` 自然清偿。
- 回归证明：删除后跑全量 `npm run regress`（gates + vitest + coverageGate + web:test），
  全绿即证明无隐性调用方。

## 5. 恢复方式

本批是单个原子提交——`git revert` 即可整簇恢复（这也是「删除而非改写」的原因：AG-UI 的
设计与其 19 个判据都留在 git 历史里，将来若真要做 agent ↔ UI 事件层，revert 后接线即可）。
