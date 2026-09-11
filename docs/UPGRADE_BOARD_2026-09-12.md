# 框架升级进度看板（2026-09-12 最新）

> 权威路线：`docs/UPGRADE_PLAN_SYNTHESIS.md` 的 U1–U7。
> 口径：✅ 已完成（代码落地 + 实测/单测验证）· 🟡 部分完成（核心已落地，仍有验证/规模化缺口）· ⚪ 待启动（仅设计，代码未写）。
> 本版依据 2026-09-12 全库代码复核 + A2A 回环实测**推翻并取代** 2026-09-05 版（旧版对 U1/U4/U6 的「代码未写」判断已过时）。
> 真实基线（2026-09-12）：**全量单测 1127 通过 / 门禁全绿**（tsc/eslint/构建/单测/集成；当日提交 `663482e`）。

---

## 一、进度快照（两套口径，避免误读）

| 口径                             | 进度      | 说明                                                                                                   |
| -------------------------------- | --------- | ------------------------------------------------------------------------------------------------------ |
| **计划层（U1–U7 七阶段）**       | **≈83%**  | 5 完成 / 2 部分 / 0 未启动（加权：done=1, partial=0.4）。较 09-05 版 ≈40% 大幅上修                      |
| **执行主线（已驱动的升级动作）** | **≈100%** | U1–U7 七项**全部有代码落地**；U3 语义层、U5 eval 规模化仅剩验证/规模化缺口                             |

> 一句话：U1 统一场、U4 RLVR、U6 A2A 三块「设计稿」已全部变成代码并接生产（runtime 接线 + 单测绿）；U6 回环实测本轮补齐转 ✅。剩余硬缺口集中在 **U5 官方基准规模化 + CI 接入**；U3 为已结案的诚实天花板。

---

## 二、逐项看板（U1–U7 + 基础项）

| ID       | 升级项                          | 状态 | 已落地证据                                                                                                                                                                                                                                                                                     | 剩余缺口（需补充）                                                                                                                                               |
| -------- | ------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **基础** | 零依赖铁律 → 必要即可依赖       | ✅   | `scripts/check.mjs` 四闸门准入 + `dependency-allowlist.json` + `docs/DEPENDENCY_POLICY.md`；当前 `dependencies` 仍 0                                                                                                                                                                            | —                                                                                                                                                                |
| **U1**   | 共振场统一基板（ResonantField） | ✅   | `ports/resonantField.ts` + `adapters/memory/resonantFieldEngine.ts`；`memoryStackAssembler` **默认开启**（`resonantField.enabled !== false`），单一 `ResonantFieldEngine` 同时充当长期记忆+宇宙网，消除双状态源；单测 `resonantField.test.ts` + `resonantFieldDefault.test.ts` 绿                 | —                                                                                                                                                                |
| **U2**   | repo-map 接生产循环             | ✅   | `contextEngine` + `repoMapContext`(TTL 缓存) + `contextAssembler` + `stepRunner/agent` 注入；live 真跑 3/3                                                                                                                                                                                       | —                                                                                                                                                                |
| **U3**   | 共振语义层融合（破召回天花板）  | 🟡   | 语义骨架 + 混合检索接生产（默认关）；minilm **Hybrid 59.4%（vs 诚实基线 BM25 43.3%）**；e5-large-v2 64.8%（高召回可选预设）；2×2 消融 + 成本报告齐备（`evals/validation-2026-09-05.md` §7–§10）                                                                                                | **已结案（诚实天花板）**：KPI 67%→≥80% 未达成，瓶颈在 embedding 模型本身；codeGraph/LSA/频谱三项重评均不翻盘。换更强嵌入须端到端证增益为正，否则不再投入                 |
| **U4**   | 进化闭环升格为 RLVR             | ✅   | `evolution/verifiableReward.ts`（编译/测试绿可验证奖励，fail-closed：异常→0）+ `rlvrLoop.ts`（**StarPO sample-filter-replay**：采样→可验证奖励打分→绿样本回放缓冲）+ `rlvrController.ts`；runtime 经 `config.evolutionRlvr` 接线（enabled+skillRegistry 才启用，缺省零破坏）；单测 `evolutionRlvr.test.ts` 绿 | 梯度级稳定化不适用（本地进化为提示词/采样驱动，非梯度训练）；端到端 autoRun 实跑未开（默认关），如需实战验证须显式开启并跑通验证命令                                     |
| **U5**   | 专属 eval 门禁（规模化）        | 🟡   | `evals/live/bench.mjs` 任务集扩到 12+（`--repeat/--pass-k/--min-pass-rate` Pass@k 门禁）；`benchmark/swebenchTasks.mjs` SWE 风格任务子集（`--swebench` 零 key replay、`--swebench-remote` 联网子集）；真实 DeepSeek 跑分 3/3；自研套件 10/10（$0.20）                                             | ①**官方 SWE-bench Verified 子集**（当前为自研本地子集，联网子集未常态化）；②**接 CI**（`.github/workflows` 缺失，门禁只在本地跑）；③Terminal-Bench 子集；④对竞品横向对比 |
| **U6**   | A2A 互操作客户端                | ✅   | `a2aProtocol/a2aClient/a2aServer/httpA2aTransport` 全落地 + runtime 接线（server 监听 + client 委托，缺省零破坏）；单测 `a2a.test.ts` 绿；**回环实测（本轮补齐）**：串行 30 任务 **完成率 100%、延迟 avg 2.5ms / p95 5ms / max 7ms**；并发 5×50 任务 **100%、avg 10.8ms / p95 28ms**（`evals/a2a-loopback.mjs` + 两份 report.json） | 已测口径为 **localhost 传输层+协议层回环**（不含 LLM 推理）；跨进程/跨机部署形态与真实子 agent 委托链路未测                                                              |
| **U7**   | 全链路零依赖铁律自检            | ✅   | `check.mjs` 阻断级门禁 + 预提交钩子；新增模块零第三方（ports/core 恒 free）                                                                                                                                                                                                                     | —                                                                                                                                                                |

---

## 三、待补充清单（按 ROI / 依赖排序）

1. **U5 eval 规模化**（唯一硬缺口，对竞品可证伪的关键）
   - 接官方 SWE-bench Verified 子集并常态化联网跑分（现有 `--swebench-remote` 钩子已预留）。
   - 建 `.github/workflows` CI：门禁四闸门 + 单测 + Pass@k 规模化门禁（`--min-pass-rate`）。
   - Terminal-Bench 子集 + 对竞品横向对比。

2. **U6 跨进程/跨机扩展**（可选增强）
   - 当前实测为 localhost 回环；WebSocket 传输、跨机延迟与真实子 agent 委托链路待测。

3. **U4 autoRun 实战验证**（可选）
   - `evolutionRlvr.autoRun` 显式开启，跑通「采样→验证命令→绿样本回放」端到端闭环。

4. **尾账（与升级主线无关但须记着）**
   - OS 沙箱真实隔离：bwrap/seatbelt/landlock 仍为 fail-closed 占位，待 Linux/macOS 真机验证。

---

## 四、诚实边界（不夸大）

- **有硬数字支撑的部分**：上下文效率 114x vs 整语料、7.97x vs grep 竞品且召回更高；live 真实跑分 3/3、自研 SWE 套件 10/10；U6 回环实测 80 任务 0 失败、串行 p95 5ms。
- **未坐实的部分**：官方 SWE-bench Verified 大规模 Pass@k 仍缺（自研子集 ≠ 官方基准）；U6 实测限于 localhost 回环（传输+协议层，无 LLM/跨机）；U3 召回天花板为诚实结案而非达标；U4 端到端 autoRun 未开。
- **git 可追溯性缺口**：git 历史 2026-09-08 整体重建（`31878a2 re-init from working tree`），U1/U4/U6 三块代码经 re-init 入库、**无独立特性提交**，出处只能回溯到快照；后续新特性须保持独立提交。

---

## 五、git 状态（截至本次汇报）

**2026-09-08 前主线**（旧历史，经 re-init 快照保留）：`8481ce2`(铁律翻转) `2565ff3`(U2) `7f55a4a`(U4缓存) `80ce2e0`(embedding) `7561950`(live脚手架) `6157234`+`ab9b876`(live跑分) `f35a873`(语义召回接生产) 等。

**2026-09-08 re-init 后**：U1/U4/U6 代码随 `31878a2` 入库（无独立特性提交，见诚实边界）；随后为代码规范八条战役（Phase 3/4/5/6，`663482e` 收官：全库显式访问权限、文件名=类名、削 static、一文件一类、上帝类拆分），单测基线 835 → **1127 全绿**。

**本轮新增（2026-09-12）**：`evals/a2a-loopback.mjs`（U6 回环实测脚本）+ `evals/a2a-loopback.report.json`（串行 30）+ `evals/a2a-loopback.report.conc5.json`（并发 5×50）+ 本看板。

---

## 六、旧版看板

`docs/UPGRADE_BOARD_2026-09-05.md` 保留作历史存档，其中 U1/U4/U6「⚪ 待启动」的判断已被本版推翻。
