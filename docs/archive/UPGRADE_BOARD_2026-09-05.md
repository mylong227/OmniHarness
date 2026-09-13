# 框架升级进度看板（2026-09-05）

> ⚠️ **已被取代**：本版对 U1/U4/U6 的「⚪ 代码未写」判断已过时，最新进度见 `docs/UPGRADE_BOARD_2026-09-12.md`。本文件仅作历史存档。

# 框架升级进度看板（2026-09-05 最新）

> 权威路线：`docs/UPGRADE_PLAN_SYNTHESIS.md` 的 U1–U7。
> 口径：✅ 已完成（代码落地 + 实测/单测验证）· 🟡 部分完成（核心已落地，仍有验证/规模化缺口）· ⚪ 待启动（仅设计，代码未写）。
> 真实基线（2026-09-05 末）：**835 通过 / 0 真实失败 / 1 cancelled**（app-server 2 条为环境 flaky，单独重跑转绿；wsTransport 1 条 cancelled 为环境超时）。代码改动已提交 git（见文末）。

---

## 一、进度快照（两套口径，避免误读）

| 口径                             | 进度      | 说明                                                                                                             |
| -------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------- |
| **计划层（U1–U7 七阶段）**       | **≈40%**  | 2 完成 / 2 部分 / 3 未启动（加权：done=1, partial=0.4）                                                          |
| **执行主线（已驱动的升级动作）** | **≈100%** | 依赖铁律翻转 → U3 召回实测 → U2 接生产 → U4 缓存失效 → embedding 骨架 → live 跑分 → 语义召回接生产，**全部落地** |

> 一句话：用户实际驱动的"升级主线"已收口；计划里更深的三块（U1 统一场 / U4 RLVR / U6 A2A）尚未开工，另两块（U3 语义层 / U5 eval 规模化）处于"骨架已成、待真实验证"状态。

---

## 二、逐项看板（U1–U7 + 基础项）

| ID       | 升级项                          | 状态 | 已落地证据                                                                                                                                                                                                                                                                                                                                                  | 剩余缺口（需补充）                                                                                                                                                                                                                 |
| -------- | ------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **基础** | 零依赖铁律 → 必要即可依赖       | ✅   | `scripts/check.mjs` 四闸门准入 + `dependency-allowlist.json` + `docs/DEPENDENCY_POLICY.md`（commit `8481ce2`）；当前 `dependencies` 仍 0                                                                                                                                                                                                                    | —                                                                                                                                                                                                                                  |
| **U2**   | repo-map 接生产循环             | ✅   | `contextEngine`(light 索引) + `repoMapContext`(TTL 缓存) + `contextAssembler`(动态碎片) + `stepRunner/agent` 注入（commit `2565ff3`/`7f55a4a`）；live 真跑 3/3                                                                                                                                                                                              | —                                                                                                                                                                                                                                  |
| **U7**   | 全链路零依赖铁律自检            | ✅   | `check.mjs` 阻断级门禁 + 预提交钩子；新增模块零第三方（ports/core 恒 free）                                                                                                                                                                                                                                                                                 | —                                                                                                                                                                                                                                  |
| **U3**   | 共振语义层融合（破召回天花板）  | 🟡   | **语义骨架已建**：`@huggingface/transformers` 登记 + `EmbeddingPort`/`SemanticIndex`/`rrfMerge`/`TransformersEmbeddingAdapter` + 混合检索接 repo-map（默认关）；**真实权重端到端实测**：minilm 生产默认 **Hybrid 59.4%（+16.1pp vs 诚实基线 BM25 43.3%）**，符号→文件融合 +5pp（第8节）；新增 **e5 预设**（实测 57.4% 反低于 minilm，未接默认，仅可选能力） | KPI 67%→≥80% **未达成**：真实代码库诚实天花板 minilm 59.4%，瓶颈在 embedding 模型本身（非融合权重、非 light 禁用组件）；codeGraph/LSA/频谱三项重评均不翻盘（第9节），已移除 hybrid 死旋钮；换更强/代码对齐嵌入须端到端验证增益为正 |
| **U5**   | 专属 eval 门禁（规模化）        | 🟡   | `evals/live/bench.mjs` 真实 DeepSeek 跑分脚手架（无密钥 exit 1 不 mock）；**真实跑分 3/3 通过** / 64863 tokens；`benchmark/capability-swebench.json` 自研 10 题 live **10/10**（$0.20）                                                                                                                                                                     | ①扩到官方 **SWE-bench Verified 子集** + Terminal-Bench 子集；②建 `evals/swebench-lite` 接 CI，跑 Pass@k(≥5 跑)；③扩充 live 任务集到 10+ 做对竞品横向对比                                                                           |
| **U1**   | 共振场统一基板（ResonantField） | ⚪   | 仅设计：把 `resonantMemory` + `cosmicWeb` 合并为统一 `Node` 表示的场，消除多套状态源（子系统状态源 6→1）                                                                                                                                                                                                                                                    | 代码未写；需新建 `ResonantField` 适配器 + 把 code/memory/tool/subagent/task 全部建模为场投影                                                                                                                                       |
| **U4**   | 进化闭环升格为 RLVR             | ⚪   | 仅设计：把 `evolution` 奖励从启发式改「编译/测试绿」可验证奖励（RAGEN/StarPO 稳定化，避 Echo Trap）                                                                                                                                                                                                                                                         | 代码未写；需 StarPO-S（轨迹过滤+批评者+梯度稳定）接 `EvolutionController`                                                                                                                                                          |
| **U6**   | A2A 互操作客户端                | ⚪   | 仅设计：两个同构共振场共振互操作，无协议翻译层（复用 `agentIdentity` 密码学身份 + `cosmicWeb` 发现）                                                                                                                                                                                                                                                        | 代码未写；需建场间共振委托通道 + 回环延迟/完成率实测                                                                                                                                                                               |

---

## 三、待补充清单（按 ROI / 依赖排序）

1. **U3 语义层真验证**（最高优先，回报直接、几乎零新代码）
   - 真实 embedding 权重首次联网下载（~80MB）→ 离线跑 `evals/recall-compare.mjs` 端到端版 + live 混合检索对比。
   - 目标：召回 67%→≥80%、token 增幅 ≤1.5x；通过后评估 `OMNI_SEMANTIC_RECALL` 默认开关。

2. **U5 eval 规模化**（对竞品可证伪碾压的关键）
   - 扩 live 任务集 3→10+；建官方 SWE-bench Verified 子集 + Terminal-Bench 子集；接 CI 跑 Pass@k。

3. **U1 ResonantField 统一基板**（架构收敛，消除多套状态源）
   - 合并 `resonantMemory` + `cosmicWeb` 为统一场；风险低但属重构切面，需排期。

4. **U4 RLVR 升格**（自改进闭环）
   - StarPO 稳定化接进化闭环；RL 不稳需批评者+梯度稳定，风险中。

5. **U6 A2A 互操作客户端**（差异化机会，全行业空白）
   - 场间共振委托通道；本地回环延迟实测。

---

## 四、诚实边界（不夸大）

- **"碾压"结论有硬数字支撑的部分**：上下文效率 114x vs 整语料、7.97x vs grep 竞品且召回更高（方法论已修正为公平对比）；live 真实跑分 3/3、自研 SWE 套件 10/10。
- **未坐实的部分**：官方 SWE-bench Verified 大规模 Pass@k 仍缺；混合检索真实代码语料端到端已复测（minilm **59.2%** / e5-large-v2 **64.8%**，2×2 消融见 `evals/validation-2026-09-05.md` §10），**KPI 67%→≥80% 未达成**，瓶颈在 embedding 模型本身（非融合权重、非 light 禁用组件、非分块召回——分块实测为零增益/有害），换更强嵌入须端到端证增益为正；U1/U4/U6 全为设计，落地前是理论。
- **OS 沙箱真实隔离**：bwrap/seatbelt/landlock 仍为 fail-closed 占位，待 Linux/macOS 真机验证（与升级主线无关，但属已知尾账）。

---

## 五、git 状态（截至本次汇报）

**已提交**：`8481ce2`(铁律翻转) `2565ff3`(U2) `7f55a4a`(U4缓存) `80ce2e0`(embedding) `7561950`(live脚手架) `6157234`+`ab9b876`(live跑分) 等。

**已补交**：上轮"语义召回接 repo-map 生产"改动已在 `f35a873` 入库（32 文件 / +2838/−98，门禁全绿）。

**本轮新增（推翻并修正上轮 RRF 调参，见 `evals/validation-2026-09-05.md` 第 7 节）**

- **测量纠偏**：上一轮 `65.9%/+2.5pp` 建立在错误基线上——锚点 `prevHash` 在语料中不存在（GT=0），兜底算 100% 白送约 10pp。已加硬守卫（GT=0 算 0%）+ 扩到 33 条真实查询，诚实基线 **BM25 43.3%**。
- **根因修复（零依赖零下载）**：文件语义文档原只取正文前 600 字符（≈import 样板），语义天花板仅 44.6%。把**符号名**塞进文档后天花板 **44.6% → 50.7%（+6.1pp）**——比所有 RRF 调参都值钱。
- **表示修好后权重翻转**：最优 `semWeight` 从 0.5 跳回 **1.0**；生产默认 Hybrid **54.1%（+10.8pp）**，分布 ↑6/↓1/=26（6 条真实语义赢，非单条拉动）。
- **诚实承认**：「融合召回只增不减」对逐查询是假的。1 条回退（`ToolCallRef` 20%→0%，GT 落在 BM25 11–14 位中段）；新增 `bm25Floor` 保护位（默认关）扫描 floor=0/6/8/10 全为 no-op——保护位只钉头部、救不了中段。代码注释已改正谎话。
- 修复 `0 || dflt` 吞掉显式 `semWeight=0` 的解析 bug（改 `numericKnob()`）；新增 `bm25Floor` 保护位单测，repoMapContext 套件 11/11 绿。全量 835 通过 / 0 真实失败 / 1 cancelled。

**本轮新增（符号→文件融合，见 `evals/validation-2026-09-05.md` 第 8 节）**

- **证伪假设**：以为「符号粒度是未挖杠杆」。诊断显示符号级语义天花板 53.1% vs 文件级 53.6% vs BM25 43.3%——符号粒度**没赢**（大 GT 查询单个符号映射漏掉其他 GT 文件）。瓶颈在 embedding 模型本身（all-MiniLM 对代码语义上限 ≈53%）。
- **但「符号命中并入文件排名」是真增益**：实现 `mergeSymbols` 旋钮（默认**开**），把语义符号映射回文件作为第三路并入 `mergedFile` 的 RRF（共指文件双重加权顶进 Top-K，是叠加非替换）。
- **结果**：生产默认（merge 开）**BM25 43.3% → Hybrid 59.1%（+15.8pp）**，比 merge 关的 54.1% **再 +5pp**；分布 ↑10/↓2/=21（10 受益 2 回退，非单条拉动）。2 条回退均为大 GT（≥10）查询（`sandbox denial` / `ToolCallRef`），语义噪声，可接受。
- eval 新增「符号级语义天花板」诊断段；主报告重写为 merge 开规范值，旧 merge 关基线存 `recall-codebase-real.report.baseline.json` 备查。新增 `mergeSymbols` 单测（接线 + fail-closed），repoMapContext 套件 13/13 绿。
- 下一步真要再破天花板（KPI 67%→≥80% 远未达成）：换代码专用 embedding（e5-code/unixcoder）或重评被禁用的 codeGraph/LSA/频谱组件（符号名修复前实测零增益，修复后可能翻盘）。

**本轮新增（两条「破天花板」路径诚实重测，见 `evals/validation-2026-09-05.md` 第 9 节）**

- **两条「翻盘」假设都被诚实数据推翻**：
  - **Path① 换代码 embedding（e5 家族，分档）**：代码改造落地（`EmbeddingPort.role` + 多模型预设 `minilm`/`e5-*`/`gte-large` + e5 `query:`/`passage:` 前缀注入，单测 5/5 绿）；**e5-base-v2 实跑 57.4%，反低于 minilm 59.2%（−2.0pp），base 档未翻盘**；但**后续补测 e5-large-v2（1024 维）实翻：64.8%（+5.6pp vs minilm）**——容量档是真实杠杆，阈值在 base 与 large 之间（详见 §10）。minilm 维持默认（22MB/81s），e5-large-v2 降级为高召回可选预设（321MB/23.6min 构建税）；unixcoder 在 Xenova 镜像无 ONNX 权重（404）不列入。
  - **Path② 重评 light 禁用组件**：同 corpus 受控重测，codeGraph **−6.1pp（负）**、LSA **+0.0pp（no-op）**、频域频谱 **0.0pp（纯零效应，FULL corpus 开关隔离铁证 `evals/diag-spectrum.mjs`）**；三项均不翻盘，light 禁用正确。
  - 因生产语料恒 light（`symbolSpectra=[]`），hybrid 内 `spectrumRecall` 旋钮是死代码，已移除（接口 + 实现 + import + 失效单测），消除误导。`transformersEmbedding.test.ts` 5/5、`repoMapContext` 套件（移除失效 spectrumRecall 测试后）全绿，全量 `tsc` 零错误。
  - 证据：`evals/recall-e5.report.json`、`evals/recall-minilm.report.json`、`evals/diag-spectrum.mjs`；本轮 2×2 消融 `evals/recall-{minilm,e5large}-{chunkoff,chunkon}.report.json` + 成本 `evals/chunk-cost-{minilm,e5-large-v2}.report.json`（见 §10）。
