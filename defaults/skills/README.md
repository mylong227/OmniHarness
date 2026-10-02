# 随包出厂的技能集（defaults/skills/）

本目录存放 **OmniHarness 自带**的技能，随 npm 包一起发布（`package.json` 的 `files` 已含 `defaults`）。

## 文件

| 文件                | 内容                                                                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `harness-core.json` | 13 条面向**本仓库自身领域**的技能（编码标准 / 门禁 / 两关评测纪律 / 端口-适配器装配 / 工具注册 / 沙箱与审批 / 上下文压缩 / 评测撰写 / strict TS / fail-closed / AppServer RPC / 召回结论 / 依赖政策）。 |

> **命名注意（别再踩）**：`.gitignore` 里有一条**裸模式** `omniharness.json`，它会匹配**任意目录**下
> 同名文件。故本文件**不能**叫 `omniharness.json`（那样会被静默忽略、发布时丢失）；`harness-core.json`
> 是刻意取的、经过 `git check-ignore` 验证不被忽略的名字。

## 怎么用

```bash
# 1) CLI：把技能包喂进去（可与配置文件内联的 skills 合并，同名以旗标为准）
omniharness --skills defaults/skills/harness-core.json "帮我加一个新能力"

# 2) 配置文件：把 skills 数组内联进 omniharness.json 的 skills 键
#    字段要求见 docs/integration.md（name / description / instructions 非空，tags 可选）

# 3) 评测：技能路由对照评测默认读本文件
node evals/skill-routing-ab.mjs --gate
OMNI_SKILLS_FILE=/path/to/other.json node evals/skill-routing-ab.mjs   # 换语料
```

## 内容口径（诚实登记）

- 这些技能是**真实可用的**，且每条要点都可由仓库内文件核对（`docs/CODE_STANDARD.md`、
  `docs/REFACTOR_BOARD_2026-09-12.md`、`docs/POLISH_PLAN.md`、`docs/DEPENDENCY_POLICY.md` 等），
  **不复制任何外部项目的文本**。
- 语料规模 **13 条**是刻意的下限而非目标：它足以让「字面包含 vs 相关性检索」的差异可测
  （见 `evals/skill-routing-ab.mjs`），但**远低于**本仓「扩到 n≥80 再下统计结论」的历史口径——
  该 eval 的结论里已明确登记这一边界，引用其数字时不得省略。
