---
'@mylong227/omniharness': patch
---

配置子环拆解：把 `SubagentPortSeed` / `MediaStack` 两个契约搬进 ports（G25-b）。

## 问题

G25 拆掉 20 成员「装配-运行时大环」后，残留一个 4 成员**配置子环**：

```
configBuilder ──type──▶ configFactory ──▶ configToolRegistry ──type──▶ configFactory
                                        └▶ corePortsAssembler ──▶ configBuilder
```

成因不是"接口没抽到 ports"，而是**类型住在实现文件里**：`SubagentPortSeed`（内含 `MediaStack`）
声明在 `configFactory.ts`，于是 `configBuilder` / `configToolRegistry` 必须反向 import 它。

## 改动

1. 新增 `src/ports/media/mediaStack.ts`（`MediaStack`：抽帧器 + 已收敛选项，两个字段本就是端口类型）；
2. 新增 `src/ports/config/subagentPortSeed.ts`（`SubagentPortSeed`，引 `SubagentPortsShape` /
   `SubagentOptions` / `MediaStack`）；
3. `configFactory.ts` / `mediaStackAssembler.ts` **只再导出**（公开 API 面不变 ⇒ `api:check` 无快照变更）；
4. `configBuilder.ts` / `configToolRegistry.ts` 改为从 ports 直连 ⇒ 两条回边消失，依赖方向恢复单向；
5. `scripts/architectureGate.mjs` 的 `CYCLE_WL_MEMBERS` **收紧 25 → 21**（删掉 4 个已出环成员，
   不留陈旧豁免），并把环⑥的注释更新为"已拆解"。

**实测：环组 6 → 5**，架构门禁通过。

## 判据（`tests/unit/configCycleDisbanded.test.ts`，4 例）

① 两个类型住在 ports 且是**纯声明**（无 `class`、只允许 `import type`、不引第三方/node 内置）；
② 两个原位置仍**再导出**同名类型（防破坏性 API 变更）；
③ **关键回边不得复活**：`configBuilder` / `configToolRegistry` 不得再 import `configFactory`，
且必须从 ports 直连（把"该往哪修"钉到文件级）；
④ 实测架构门禁：**环组 ≤5**、**白名单成员 ≤21**、白名单里不得再有那 4 个成员。

**变异**：把回边加回 `configBuilder` ⇒ 判据 ③④ 变红，**同时**架构门禁报「依赖环：6 组（新增 1）」
并中止 ✓ —— 两条独立防线都拦得住。

## 验证

`tsc --noEmit` 零错误；`npm test` 全绿；`runGates --tier=all` 两层跑通；
`api:check` / `rust:test` / `web:test` 全绿。看板第二十八轮横幅与报告 §4 G25 行同步。

## 路线图状态

至此 `docs/ARCHITECTURE_UPGRADE_2026-10.md` §4 的登记遗留项**全部清零**
（G1b-c / G8-c / G10-T2 / G20-b / G21-b / G25-b）。唯一未获独立证明的是
**G1b-c 里"L4 显式对齐是否必要"**（变异实测删掉它判据照样绿），已另立 **G1b-c2** 继续追。
