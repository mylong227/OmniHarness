# 长任务自锁修复（2026-10-26）

## 真实故障

用真实模型跑 `strings-basic` 长任务时：

1. 首次写类工具被策略拒绝（审批/沙箱/监督内核）；
2. `recordToolResult` 把它当作工具健康失败上报；
3. 危险工具一次失败即推进 `supervisor` 到 `safe`；
4. `safe` 模式又拒绝后续所有写类工具，模型转入 `tool_search` 空转；
5. 实测从约 3 分钟拖成 **3 小时**，最终 `fetch failed`。

日志证据（会话 `sess_mvnzkz9b_1`）：

```text
supervisor.transition nominal -> safe tools=2
tool.denied write_file ... 监督内核(safe)：危险工具在安全模式下拒绝
tool.denied edit ... 监督内核(safe)：危险工具在安全模式下拒绝
tool.call tool_search ... (重复数小时)
turn.loopguard.nudge violation=soft-deadline
```

## 修复

- 新增 `src/supervisor/healthSignal.ts`：识别策略拒绝（`监督内核(safe/locked)`、审批、
  沙箱、`approval/denied/permission/sandbox/policy`、`EPERM`）。
- `StepToolExecutor.recordToolResult`：策略拒绝**不再上报** supervisor 失败；真实执行失败
  （异常/超时/验收失败）仍上报。
- 效果：一次拒绝不会再触发 `nominal -> safe` 自锁；连续真实失败仍按原阈值降级。

## 判据

- `tests/unit/healthSignal.test.ts`：策略拒绝 5 例、真实失败 4 例；
- 依赖 supervisor 既有测试（危险工具失败 → safe）不变——直接 `supervisor.report('shell','failure')`
  仍是健康信号，只有**策略拒绝**在 executor 层被过滤。

## 参考解自检（本机，绕过 runner 的 spawn）

runner 的 `--self-check` 需要 spawn 验证器，本机受限；改用 PowerShell 直接对 20 个任务复制
fixture + 参考解 + 权威验证器并运行 `node verify.mjs`：

```text
SELF_CHECK_PASS=20 TOTAL=20
```

说明任务集、参考解、验证器本身可解/可通过；剩余 `eval:long` 阻塞在“runner → CLI/验证器
子进程”而非任务质量。

## 修复后复跑（真实模型，`deepseek-flash`）

- 同一 `strings-basic` 任务从约 **3 小时**降到一次正常回合（约 11 分钟），不再出现
  `nominal -> safe -> 全部写类拒绝 -> tool_search 空转`。
- 但任务**未通过验收**：模型写了 `src/index.js`/`README.md`，`README.md` 漏了 `toCamel`
  字样；且 shell 自检在本机仍被策略/沙箱拒绝，模型无法运行 `node verify.mjs` 自检。
- 结论：自锁已修；剩余是模型内容质量与**受限环境无法执行验证命令**，需普通环境或
  给 shell 放行后复跑。

## 边界

- 识别依赖错误文本特征；若未来工具返回结构化 `denial` 码，应改为读码而非正则。
- 真实长任务复跑需 API key 与可 spawn 验证器；本机已能跑 CLI 单任务，完整 `eval:long` 仍受限。

## 2026-10-27 追加：同类自锁的**第二、第三个**来源（真模型跑测再次暴露）

上一版只堵住了「策略拒绝」这一条，实测仍有两条会把会话锁死（详见 `docs/PROJECT_BOARD.md` §104）：

1. **命令非零退出被当成工具健康失败**：`shell` 属写类工具；模型跑自己刚写的红测试（`exit 1`，
   本就是要修的中间态）⇒ 一次失败 ⇒ `hazardousFailed` 直接 `safe` ⇒ shell/write_file/subagent 全拒。
   修法：`ToolResult.exitCode` 携带**真实退出码**，`SupervisorHealthSignal.isCommandOutcome`
   把「命令执行完但非零」排除出健康信号（不解析错误文案；超时/信号/启动失败仍算真实失败）。
2. **单样本失败率 = 100%**：`computeMode` 对「1 次调用 1 次失败」也套用 `safeThreshold`，
   于是任何工具的一次普通失败都能推 `safe`。修法：`SupervisorOptions.minSamples`（默认 4）——
   样本不足不做失败率判定；危险工具单次失败只降 `degraded`（不拦工具），4 次以上才按失败率
   进 `safe`；连续失败仍按 `lockAfter` 进 `locked`。

判据：`tests/unit/supervisorCommandOutcome.test.ts`（3 例：红测试 5 连不降级 / 真实失败仍计 /
超时仍计）、`healthSignal.test.ts` 增 2 例、`supervisor*.test.ts` 按新口径更新。
实测：m1 由 13/14（safe 自锁、85 步 / 3.4M prompt token）→ **14/14**；
m2 由 3/5（103 步 / 4.5M）→ **16/16**（19 步 / 358k）。
