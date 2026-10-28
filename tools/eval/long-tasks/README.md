# 长任务 fixture 集（`eval:long`，32 任务）

每个任务都是一个**可机械验收**的小仓库：agent 在隔离的临时 git 仓库里实现 `src/index.js`
的导出函数、写 `README.md`，评测器用任务自带的 `verify.mjs` 判定通过/失败。

## 目录结构

```
tools/eval/long-tasks/
  tasks/<id>.json          # 任务定义（id/prompt/repo/verifyCommand/expectedFiles/timeoutMs/maxTokens）
  fixtures/<id>/           # agent 看到的仓库（src/index.js 是 stub，verify.mjs 是可跑的验收器）
  verifiers/<id>.mjs       # 权威验收器（验收前覆盖写入，agent 的修改不算数）
  solutions/<id>.js        # 参考解（仅自检用，不复制进 fixture）
  solutions/<id>.README.md # 参考 README（仅自检用）
```

## 常用命令

```bash
npm run build                                # 跑分器消费 dist/src/eval/longTask.js
npm run eval:long -- --dry-run                # 只打印任务与配置，不调模型
npm run eval:long -- --self-check             # 不调模型：参考解必须通过全部验收器
npm run eval:long -- --k 3 --model <model> --out report.json
npm run eval:long -- --k 3 --long-horizon     # 显式开长时程协议（primer/progress/checklist）
npm run eval:long -- --only strings-basic,arrays-basic
```

## 口径与边界

- `pass@k` / `pass^k` / `tokensPerSolved` **复用** `src/eval/abMetrics.ts` 的 `AbMetrics`；
- `pass@1` 是任务集的总成功次数 / 总运行次数（单次尝试成功率），`pass@k` / `pass^k` 是**任务级占比**；
- 每任务每次运行都在独立临时 git 仓库里；`verify.mjs` 验收前从 `verifiers/` 覆盖；
- 无 `OMNIHARNESS_API_KEY` 时显式 `{skipped:true}`，不用 mock 冒充；
- token 来自模型 usage（端点不回传时为 0，不臆造估算）；
- **这 32 个任务是本仓自建的合成回归集，不是 SWE-bench / Terminal-Bench 分数**；
  单次小差异不作为收益结论（沿本仓两关纪律：配对 bootstrap CI + 留出折同向）。

## 加一个任务

1. 在 `fixtures/<id>/` 放仓库（`src/index.js` stub + `verify.mjs`）；
2. 在 `verifiers/<id>.mjs` 放权威验收器（通常与 fixture 的 `verify.mjs` 同源）；
3. 在 `solutions/` 放参考解与参考 README（`npm run eval:long -- --self-check` 会验收它们）；
4. 在 `tasks/<id>.json` 写定义（`verifyCommand` 与 `expectedFiles` 必填；没有机械验收不算成功）；
5. 跑 `--self-check`：参考解必须全绿，否则任务本身不可解。
