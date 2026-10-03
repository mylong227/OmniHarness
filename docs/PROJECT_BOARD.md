# OmniHarness 项目看板（唯一事实源）

> **本文件是仓内唯一的看板**。旧看板（`TASK_BOARD.md` / `REFACTOR_BOARD_2026-09-12.md` /
> `UPGRADE_BOARD_2026-09-12.md` / `archive/UPGRADE_BOARD_2026-09-05.md`）已于 2026-10-03 删除，
> 内容永久可查于 git 历史（`git show b49d96e^:docs/TASK_BOARD.md` 等）。
>
> **记录纪律（不可妥协）**：写入本板的每一条信息必须「本机可复核」——或附上产生它的命令/测试，
> 或标注复核日期。禁止复制未经验证的宣称；历史看板里的数字在重新实测前一律视为**待复核**。

---

## 1. 项目是什么

- **通用 Agent Harness**：TypeScript（CLI / Web 工作台 / 编排）+ Rust（原生内核）。
  包名 `@mylong227/omniharness`，版本 0.2.0，Apache-2.0，要求 Node ≥ 22.14.0。
- Rust 侧 6 个 crate：`omni-cli` / `omni-core` / `omni-napi` / `omni-sdk` / `omni-sdk-gen` / `omni-wasm`（39 个 .rs 文件）。
- Web 工作台 `web/src`：111 个 TS 文件（无第三方运行时框架，自绘 React 垫片）。
- 评测/基准设施：`evals/` 86 个文件（评测脚本 + 落盘报告）、`benchmark/`、SWE-bench 运行器（`python/` + `eval-data/`）。

### 代码规模（2026-10-03 实测，`find … | wc -l`）

| 区域                                                  | 文件数          | 行数                  |
| ----------------------------------------------------- | --------------- | --------------------- |
| `src/` 全部                                           | 905             | 95,448                |
| —— adapters（协议/工具/存储/媒体/沙箱等适配器）       | 211             | 31,685                |
| —— ports（端口契约 + 组合接口）                       | 341             | 6,165                 |
| —— server（HTTP/WS 服务与端点）                       | 47              | 9,104                 |
| —— context（检索/压缩/仓库图/记忆注入）               | 40              | 8,821                 |
| —— cli                                                | 29              | 6,212                 |
| —— core（agent 循环 / 步执行 / 工具门禁 / 暴露规划）  | 24              | 5,077                 |
| —— util / config / evolution / genesis / media / 其余 | 约 213          | 约 28,000             |
| 单元测试 `tests/`                                     | 378 个 .test.ts | 全量 2,384 项断言用例 |

## 2. 当前门禁状态（2026-10-03 实跑）

| 门禁           | 命令                               | 结果                                                   |
| -------------- | ---------------------------------- | ------------------------------------------------------ |
| 类型（含 web） | `npm run typecheck`                | ✅ 零错误                                              |
| 代码规范       | `npm run lint`（--max-warnings=0） | ✅ 0 告警                                              |
| 铁律/体量      | `npm run check -- --strict`        | ✅ 905 文件零违规（存量白名单 13 处冻结）              |
| 架构           | `npm run arch:gate`                | ✅ 依赖方向 0 / ports 纯度 0 / 依赖环新增 0            |
| 成熟度         | `npm run audit:maturity`           | ✅ 40 项声明，L2/L3 均有测试证据                       |
| 接线完整性     | `npm run audit:config-wiring`      | ✅ 905 文件全绿                                        |
| 文档死链       | `npm run check:doc-links`          | ✅ 新增 0（存量基线冻结）                              |
| 全量单测       | `npm test`                         | ✅ 2,384 项：2,374 过 / 0 失败 / 8 skip / 2 cancelled* |

\* 2 个 cancelled 是 `sessionLifecycle` / `workflowRunner` 两个文件在**并发全量**跑法下的文件级 120s 超时产物；两文件单独跑分别为 6/6 与 9/9 全绿（官方 gate `npm test` exit 0）。

依赖政策：`dependency-allowlist.json`（D10：必要且更优即可引入；`src/ports/**` 与 `src/core/**` 恒第三方-free），允许/拒绝许可清单见该文件。

## 3. 已知未修缺陷（2026-10-03 代码审计确证，按修复价值排序）

> 来源：当日对 core / context / 模型适配层 / 工具适配层的四路人工审计，25 处已当场清偿
> （提交 `b49d96e`），以下 6 项经评估**暂缓**并注明理由——

1. **rollback 不截断内存事件流**（P1）：`CheckpointManager.rollback` 只改磁盘，运行中会话的
   内存日志仍是全量，下一步 write-behind 持久化会把回滚覆盖回去。修复需要「事件日志截断 +
   持久化版本化判脏」的端口级改造（EventPersister 的长度判脏也要一并换掉）。定位：
   `src/core/checkpointManager.ts` / `src/core/loop/eventPersister.ts` / `src/adapters/tool/git/rollbackTool.ts`。
2. **TurnDiffHooks 的 before 基线跨回合不重置**（P2）：回合 2 再写同一文件时 diff 的 before 侧
   是回合 1 之前的内容，`turn_diff` 事件呈现跨回合累计差异；且基线 Map 只增不减。修复需要
   tracker↔hooks 的回合生命周期联动。
3. **压缩阈值 token 记账系统性偏低**（P2）：`TokenEstimator.estimateMessages` 只计 `content`，
   toolCalls 参数 / reasoning / 图片 / repo-map 尾段 / 工具 schema 不入账，长工具链会话可能越过
   窗口才触发压缩（fail-open 到上游 400）。修复涉及原生 FFI 估算器签名同步变更。
4. **Ollama 流式工具调用按函数名合并**（P3）：同批同名并行调用被吞并、参数片段后到覆盖。
   需要真实 ollama 后端的输出样本才能安全改（无样本不改协议解析）。
5. **SkillSparsifier 在 BM25 生产路径上是空转**（P3）：`selectForPrompt` 已截断到预算，稀疏化的
   预算判据恒真、强命中豁免永不生效——文档与行为脱节。两个方向二选一：删除该调用点，或给它
   接 BM25 分数通道让豁免判据重新有语义（后者是行为变更，须按 D6 走判据）。
6. **apply_patch 多文件落盘非原子**（P3）：第 2 个目标写盘失败时第 1 个已落盘且无回滚，
   与类注释承诺矛盾；也没有 write/edit 都有的 `.bak` 备份。

## 4. 挂起项（有明确外部条件，非「不知道怎么做」）

- **官方跑分**（SWE-bench Verified / Terminal-Bench 官方口径）：依赖付费模型 API key 与
  Linux/docker 运行环境，本机（Windows、无代理、间歇外网）不可复现。历史非官方口径数字
  见 `CHANGELOG.md`（如实标注为子集口径）；交接文档 `docs/SWEBENCH_DOCKER_HANDOVER.md` 等。
- **注入攻击度量**（T4.4）：等待真实数据集快照；当前护栏为规则式（`promptInjectionGuard`，
  已接线 agent/config/cli 生产路径，enforce/shadow/off 三态）。
- **语义召回生产端到端验证**：向量落盘缓存（`diskCachedEmbeddingAdapter`）由假嵌入端口的
  单测覆盖；真实模型端到端未验证（本机无 ONNX 权重下载条件），不得声称已实测加速。

## 5. 活跃纪律摘录（原决策日志 D1–D9 随旧看板删除，仍具约束力的口径摘录在此）

- **D6 翻默认两关**：改检索/排序类默认前，必须过 ① 否决器（新路与基线 Top-K 平均 Jaccard
  重合度过高 = 常量偏置，直接判负）② 同语料配对 bootstrap 95% CI 下界 > 0 且留出折多数为正。
  点估计为正但 CI 跨零 ⇒ 判「与噪声不可区分」，不得翻默认。**确定性集合成员**场景（如工具
  暴露）用该判据的可操作形态：接线活性 + 跨查询敏感度 + 假阳性分数地板 + CI/留出折。
- **D7 行为变更登记**：默认行为变更必须量化代价与收益并留档（例：工具暴露翻默认时
  schema token −63.4%、平均可见工具 33→14，配零能力损伤 + 100% 必需召回两道判据）。
- **D10 依赖政策**：必要且更优即可引入，同等能力优先成熟第三方；「零依赖」不构成拒绝理由；
  手写实现降格为资产 + 回退路径。权威文件 `docs/DEPENDENCY_POLICY.md`。
- **随机性必须种子化 / 门禁输出必须干净 / 测试红先分清「测试错」还是「代码错」**：详见
  `omniharness-coding-standard` skill 与 `docs/CODE_STANDARD.md`。

## 6. 快速命令（生产口径）

```bash
npm run build          # tsc + 资产拷贝
npm test               # 构建 + 全量单测（官方门禁口径）
npm run eval:ci        # 评测门禁：召回审计 + rank-veto + 缓存命中 + 工具选择 + 前缀稳定
npm run eval:skill-routing -- --gate   # 技能路由三判据（语料 defaults/skills/harness-core.json，13 条）
npm run eval:tool-exposure-e2e         # 工具按需暴露端到端（零能力损伤判据）
npm run check -- --strict && npm run arch:gate && npm run audit:maturity   # 标准三闸
```

评测纪律：`eval:lsp-ab` 依赖语言服务器，实测净负已判负、不进 CI；任何评测结论必须连同
CI 宽度与语料规模（n）一并引用，单独引用点估计视为违规。

## 7. 本板如何追加条目

1. 只追加「已复核事实」：命令 + 日期 + 结果；或「已确证缺陷」：定位（file:line）+ 复现逻辑 + 暂缓理由。
2. 推翻旧条目时**保留旧文并划掉**（~~~~），注明推翻依据——不许无声改写历史结论。
3. 与 `AGENTS.md` 分工：AGENTS.md 只放「不写就会重复踩坑」的环境事实与流程约束；本板放项目状态。
