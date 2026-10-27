# Harness A/B（评测契约入口）

`harnessAb.mjs` 回答一个问题：**同一任务、同一模型，只改 harness 配置，成功率 / pass^k /
tokens-per-solved 是否真的变了**。它不是榜单跑分器，不引用外部 benchmark 分数。

## 用法

```bash
npm run build                        # 脚本消费 dist/src/eval/abMetrics.js 与 dist/src/cli/exec.js
npm run eval:harness -- --dry-run     # 只打印任务与配置，不调模型

# 配置用 @file 形式（PowerShell/bash 都安全；文件内容是 JSON 对象）
npm run eval:harness -- --a @a.json --b @b.json --k 3 --out report.json
```

- `--a` / `--b`：两套环境变量（JSON 对象，或 `@file.json`）；脚本把它们叠到 `process.env` 上。
  报告里只回显键名，`*KEY*`/`*TOKEN*`/`*SECRET*`/`*PASSWORD*` 的值一律打码。
- `--k`：每个 task × config 跑几次（默认 1；建议 3 起步）。
- `--tasks FILE`：自定义任务数组，每项 `{ id, prompt, files }`；**`files` 必填且非空**，
  是机械验收（文件存在且 trim 后等于期望值）。没有验收的任务会被脚本拒绝——「CLI 退出 0」
  不等于任务成功。
- 无凭据时脚本输出 `{skipped:true}` 并以 0 退出——**不用 mock 冒充真实 A/B**。
- 每个 run 的事件流里带 `session_meta.manifest`（模型/工具集/提示哈希/planMode），
  报告同时给 `pass@k`、`pass^k`、`tokensPerSolved` 与 `Δsuccess/tokenRatio`。

## 口径

- `pass@k`：k 次里至少 1 次成功；`pass^k`：k 次全成功（可靠性）。
- `tokensPerSolved`：总 token / 成功次数；无成功或 token 缺失为 `null`，不写 0。
- `paired`：同 task、同 k 下的**下标对齐**比较（不是同一 run 的时序配对）；只用于同环境比较。
- **单次小差异不可信**：按本仓探针纪律，只有配对 bootstrap 95% CI 不跨 0 且留出折同向才算
  增益；本脚本只产原始数字，不替代两关判定。

## 诚实边界

- 内置任务只覆盖「写文件 + 读取确认」这类可机械验收的短任务；长任务/前端任务需要自定义
  `files` 或外部验收器。
- token 来自模型 usage；端点不回传 usage 时为 0（脚本不臆造估算）。
- 清单记录的是**注册工具集**与 `exposureMode`，不是请求期最终可见集合；A/B 的
  `OMNI_TOOL_EXPOSURE` 差异要看 manifest 的 `exposureMode` 字段。
- 启动失败、转写截断等由 CLI 退出码/`ok` 字段反映；脚本不把「文件恰好存在」当唯一证据。

## 长任务评测（`npm run eval:long`）

`longTasks.mjs` + `long-tasks/` 回答「长时程能力是否真的改变长任务表现」：20 个**可机械验收**的
fixture 仓库，每任务 k 次、每次在独立临时 git 仓库里跑，报告 `pass@1 / pass@k / pass^k /
tokensPerSolved`（口径复用 `src/eval/abMetrics.ts` 的 `AbMetrics`，不复制公式）。

先 `npm run build`：

```bash
npm run eval:long -- --dry-run                 # 只打印任务与配置
npm run eval:long -- --self-check              # 不调模型：参考解必须通过全部验收器
npm run eval:long -- --k 3 --model <model> --out report.json
npm run eval:long -- --k 3 --long-horizon      # 显式开长时程协议（primer/progress/checklist）
npm run eval:long -- --only strings-basic,arrays-basic
npm run eval:long -- --k 1 --timeout-scale 2 --only json-basic   # 预算敏感性对照（非基准口径）
```

- 每任务 JSON 必填 `id/prompt/repo/verifyCommand/expectedFiles/timeoutMs/maxTokens`；
  没有 `verifyCommand` 或 `expectedFiles` 的任务会被拒绝（「CLI 退出 0」不等于成功）。
- `--timeout-scale`（默认 1）只放大**单任务超时**，不改任务规格；报告记录倍率、摘要标注
  「非基准口径」，用于区分「预算不足导致的超时」与「能力失败」。`timeoutMs` 是基准口径，
  对外报数必须用 1×。
- 验收 = CLI 退出 0 + `ok:true` + `verifyCommand` 通过 + `expectedFiles` 齐全；
  `verify.mjs` 在验收前从 `verifiers/` 覆盖写入（模型改验收器不算数）。
- 无 `OMNIHARNESS_API_KEY` 时输出 `{skipped:true}` 并以 0 退出——不用 mock 冒充真实跑分。
- 每次运行写 transcript（stdout/stderr/验证输出），报告回传路径。
- `--long-horizon` 显式设置 `OMNI_LONG_HORIZON=1` + `OMNI_LONG_HORIZON_TASK/VERIFY`；不加时
  显式设置 `OMNI_LONG_HORIZON=0`（对照基线，避免复杂 prompt 自动开启污染 A/B）。

**诚实边界**：20 个 fixture 是本仓自建的合成任务，不是 SWE-bench / Terminal-Bench 分数；
token 来自模型 usage（端点不回传时为 0，不臆造估算）；单次小差异不作为收益结论。

## trace → patch 计划（`npm run trace:patch`）

先 `npm run build`（脚本读取 `dist/src/eval/tracePatchPlanner.js`）：

```bash
npm run trace:patch -- --input signals.json          # markdown
npm run trace:patch -- --input signals.jsonl --json  # 机器读
```

输入是失败信号数组（或 JSONL）：`{tool, ok, output, path, command}`。输出复现命令、涉及文件、
最小修改假设、验证命令。**它不改文件、不自动合并**——自动落补丁必须先有验证闭环。

## LongMemEval-S 代理（`npm run eval:longmem`）

先 `npm run build`：

```bash
npm run eval:longmem -- --dataset tools/eval/datasets/longmemeval-s.sample.json --json
npm run eval:longmem -- --dataset cases.json --trusted-only
```

输入 `{cases:[{id,question,answer,facts:[{text,trust?}]}]}`；用真实 `FileLongTermMemory` 召回 top-k，
按答案文本命中报告 recall@k / MRR。它是**本地检索代理**，不是官方 LongMemEval-S 的模型判分复刻。
