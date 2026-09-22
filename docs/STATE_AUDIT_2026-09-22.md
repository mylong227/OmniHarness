# OmniHarness 状态盘点（2026-09-22 · 本会话实测版）

> **盘点方法**：不采信看板/README 的任何自我宣称，全部结论以本会话**实跑证据**为准。
> 覆盖：静态六闸门 + 全量单测 + Web 单测 + 集成测试 + smoke + 两条度量脚本复算 +
> **与 HEAD 基线的逐文件测试对拍**（`git worktree` 隔离基线，不动当前工作树）。
> 证据落盘（`.omniharness/` 已被 `.gitignore` 忽略，不入库）：
> `perfile-unit-HEADPLUS.tsv`、`perfile-unit-BASE.tsv`、`perfile-web-HEADPLUS.tsv`、
> `perfile-web-BASE.tsv`、`audit-unit.tap`、`audit-integration.tap`。

---

## 0. 一页结论

| 维度                 | 判定            | 依据（本会话实测）                                                                                                                              |
| -------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **代码基线**         | ✅ 稳定         | `HEAD=6e6b31c`，317 提交；工作树仅一批**在途改动**（§17 批次），无冲突、无半成品残骸                                                            |
| **静态闸门**         | ✅ 全绿         | build / typecheck / lint / check --strict / arch:gate / audit:config-wiring / audit:maturity / api:check / format:check **九项 exit 0**         |
| **在途批次是否回归** | ✅ 无回归       | 与 HEAD 基线**逐文件对拍**：失败集合一致（唯一差异由基线 worktree 缺原生二进制导致 skip 变化）                                                  |
| **在途批次是否可信** | ✅ 数字可复算   | `metrics:tool-exposure` 33→10.0 工具 / 6937→2167 token（−68.8%）；`metrics:injection` recall 90.0% / FP 8.3% —— 与看板 §17 记载**逐字一致**     |
| **测试绝对绿灯**     | ⚠️ 本环境不可得 | 74 单测 + 2 Web + 2 集成失败，**全部**源于本沙箱禁止「带管道 stdio 的子进程」（`spawn EPERM`），非代码缺陷                                      |
| **Rust 侧**          | ⚠️ 本会话未覆盖 | 本机无 Rust 工具链（`~/.rustup` 不存在，`cargo` 仅为 rustup 代理）且环境**无网络**；Rust 三道闸门本会话**无法验证**                             |
| **发布状态**         | ✅ 已收口       | 在途批次按 changeset 分笔入库（`76b186f` / `5d5646a` / `3ed7c11` + 本笔 docs），工作树清零；**18 个 changeset** 待消费（本批 3 个已随提交入库） |
| **本轮收尾**         | ✅ 全部闭环     | 盘点列出的 6 项问题**逐项处置**（dist 清理 / 目录告警 / 残留文件 / README 数字 / 入库 / Rust 如实登记）——见 §8                                  |

**一句话**：项目处于**健康的在途状态**——上一批次（§17 工具按需暴露 / 护栏三态化 / 嵌入预热）已按「装配→运行时→消费」全链接线并留下可复算数字，静态门禁全绿、对拍无回归；盘点发现的唯一实质工程隐患 **`dist/` 构建产物从不清理**（§5.1）已修复并入库，其余为环境性限制或已登记的挂起项——**收尾明细见 §8**。

---

## 1. 复核方式（可照抄复跑）

| 项           | 命令                                                                                                                                       | 备注                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| 静态闸门     | `npm run check -- --strict` / `typecheck` / `lint` / `arch:gate` / `api:check` / `audit:maturity` / `audit:config-wiring` / `format:check` | 全部 exit 0                                              |
| 全量单测     | `node --test --experimental-test-isolation=none "dist/tests/unit/*.test.js"`                                                               | **必须加** `--experimental-test-isolation=none`，见 §4.1 |
| 逐文件对拍   | `.omniharness/audit-perfile.ps1 -Root <树> -Glob "dist/tests/unit/*.test.js" -Out <tsv>`                                                   | 本会话新增的盘点脚本（不入库）                           |
| 集成 / smoke | `node --test --experimental-test-isolation=none "dist/tests/integration/*.test.js"` / `node dist/tests/smoke.js`                           | smoke exit 0                                             |
| 度量复算     | `npm run metrics:tool-exposure` / `npm run metrics:injection` / `node evals/injection-calibrate.mjs`                                       | 免网络免模型                                             |

---

## 2. 仓库快照

| 项        | 值                                                                                                                                            |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| HEAD      | `6e6b31c docs(board): §16 前端逐块真实高度已接线 + 真机截图存档`（2026-09-21 22:47）                                                          |
| 提交数    | 317（分支 `main`）                                                                                                                            |
| 版本      | `0.1.0`（未发布，`Unreleased` + **18 个 changeset** 待消费）                                                                                  |
| 工作树    | 13 个已跟踪文件修改（+552 / −39），15 个未跟踪条目（3 changeset + 2 新 src + 5 新测试 + 2 新 eval + 2 报告 + 1 盘点用基线 worktree 临时目录） |
| 规模      | `src` 560 TS / 65,780 行；`tests` 335；`web/src` 104；`crates` 6 / 4,904 行 Rust；`docs` 87                                                   |
| 真实 TODO | `src` 内 `TODO:`/`FIXME`/`HACK` **仅 2 处**，且都在 `selfChecklist.ts` 的「禁止标记」检测表里（非遗留债）                                     |
| Node      | v22.20.0（满足 `engines >=22.14.0`，`check:node` ✅）                                                                                         |
| 远端      | `origin`=omniharness/omniharness，`mine`=mylong227/OmniHarness（均经 ghproxy）；`main` 的 upstream 已 `[gone]`                                |

---

## 3. 在途批次（未提交）盘点

内容：**§17「借鉴外部 System 1 决策项目」的第二、三批**，全部围绕「装配→运行时→消费」全链。

| 主题                       | src 改动                                                                                                                                                   | 测试                                         | 复算证据                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------ |
| **工具按需暴露**           | `src/core/toolExposurePlanner.ts`（新）+ `stepContextBuilder.effectiveTools` 接线                                                                          | `toolExposurePlanner` 13/13                  | 33→10.0 工具、6937→2167 token（−68.8%），三护栏 10/10/10                       |
| **护栏三态化（D1/D2）**    | `src/security/enforcementMode.ts`（新）+ `stepToolExecutor` / `configFactory` / `cliEnums` / `cliFlagTable` / `argParser` / `cliBuildConfig` / `stepTypes` | `enforcementMode` 7/7、`guardShadowMode` 7/7 | 非法模式装配层抛错；`shadow` 逐字原样                                          |
| **陈旧 schema 绑定（D4）** | `stepContextBuilder.effectiveTools` 以当前目录为准                                                                                                         | `toolCatalogSnapshot` 4/4                    | 卸载后不并入、仍在则取最新定义                                                 |
| **嵌入预热（L5）**         | `transformersEmbeddingAdapter`（可注入 loader + `preload()` + **失败可恢复**修缺陷）+ `ports/model/embedding.ts` + `configFactory.buildEmbeddingPort()`    | `embeddingPreload` 9/9                       | 默认关 ⇒ 零行为变更；`OMNI_EMBED_PRELOAD=1` 后台预热                           |
| **阈值校准（L3）**         | `evals/injection-calibrate.mjs`（不改 src）                                                                                                                | —                                            | 同源校验 32/32；手设值 acc 排名 5/256，**9 向量并列** ⇒ 只证明敏感性、不作选型 |
| **降档可读理由（L6）**     | `stepContextBuilder.buildRepoMapContext` 带 `reason`/`effect`/`queryChars`                                                                                 | 既有 `stepContextBuilder*` 全绿              | —                                                                              |

**风险面评估**：默认行为零变更（`OMNI_TOOL_EXPOSURE` 未设 ⇒ `off`；`OMNI_EMBED_PRELOAD` 未设 ⇒ 不预热；
护栏历史二值写法 `true/false` 语义不变），新增能力全部 opt-in，且装配层对非法取值**抛错而非静默回落**。

---

## 4. 测试实况与归因

### 4.1 为什么必须换一种跑法

默认命令 `node --test "dist/tests/unit/*.test.js"` 在本会话**315/315 全红**——Node 测试运行器为每个文件
spawn 子进程并捕获其 stdout，而本沙箱**禁止带管道 stdio 的子进程**（`spawn EPERM`，属沙箱既定边界）。
改用 `--experimental-test-isolation=none`（同进程内跑，不 spawn）后得到真实结果。

### 4.2 实测结果

| 套件  | 文件 | 用例 | 通过 | 失败   | 跳过 |
| ----- | ---- | ---- | ---- | ------ | ---- |
| 单元  | 315  | 2031 | 1940 | **74** | 17   |
| Web   | 27   | 236  | 234  | **2**  | 0    |
| 集成  | —    | 11   | 9    | **2**  | 0    |
| smoke | —    | —    | 全过 | 0      | —    |

### 4.3 失败归因（逐条落实，非推测）

- **单测 74 例 / 31 文件**：全部落在需要真实子进程的区域——CLI 子进程（`headless`/`cliSystem`/`cliDataCmds`/
  `auditExport`/`complianceExport`）、shell（`shellTool` 报错原文即 `执行失败: spawn EPERM`；
  `shellProcessRunner`/`nativeAliasBridge`）、LSP 进程适配器（`lspProcess` 报错原文 `error: 'spawn EPERM'`，
  5 例）、MCP 子进程桥、worktree/git、eval 隔离执行（`swebench`/`rlvr`/`evolutionRlvr*`/`evalShell`）、
  api:check / configWiring（断言的是被 spawn 脚本的**捕获输出**，EPERM 下为空 ⇒ 断言失败：实测原文
  `selftest 应全通过，实际输出：undefinedundefined`）、Chrome e2e。
- **Web 2 例**：`e2e-cdp.test.mjs`（`error: 'spawn EPERM'`，启动本机 Chrome）与 `e2e.test.mjs`（headless 浏览器）。
- **集成 2 例**：`真 serve + 真 SPA + 真 Chrome`（`spawn EPERM`）与 `P3 自验证回环`（其自验证命令须 spawn）。
- **基线对拍（决定性证据）**：用 `git worktree` 在 `HEAD` 上建隔离基线、独立 `tsc` 构建后逐文件跑同一脚本：

  | 树                      | 文件 | 通过 | 失败 | 跳过 | 失败文件 |
  | ----------------------- | ---- | ---- | ---- | ---- | -------- |
  | 当前（HEAD + 在途批次） | 315  | 1940 | 74   | 17   | 31       |
  | 基线（纯 HEAD）         | 309  | 1887 | 73   | 27   | 30       |

  逐文件差异**只有一处**：`nativeAliasBridge.test.js` 在基线里 3 例 **skip**（基线 worktree 无 `native/*.node`，
  属 `.gitignore` 产物）而在当前树实跑并失败（`spawn EPERM`）。**失败集合与失败原因完全一致 ⇒ 在途批次无回归。**
  新增 5 个测试文件（40 例）全绿，是 pass 1940−1887 的主要来源。

> **结论**：本环境的红不是缺陷信号，而是沙箱边界；这些用例在 CI（ubuntu/macos/windows runner + 真浏览器）才是真门禁。
> 与看板 §17.5 的记载同因，但**本会话的失败数（74）等于该批次落地前的基线数**，可证「本批次没多坏一个用例」。

---

## 5. 发现的问题与风险（按严重度）

### 5.1 🟠 `dist/` 从不清理 ⇒ 陈旧产物会「继续跑」「继续发布」

`npm run build` 只执行 `tsc`（无 clean），且 `tsconfig` 非增量清理模式，于是**被改名/删除的源文件，其编译产物永久留在 `dist/`**。实测：

- `dist/tests/unit/budgetDegradeAdapter.test.js` —— 源文件 `tests/unit/budgetDegradeAdapter.test.ts` **已不存在**
  （改名为 `costBudgetDegradeAdapter.test.ts`），但其**陈旧副本仍在 `dist/tests/unit/*.test.js` 通配内被 `npm test` 执行**（4 例，且与新版内容不同：hash 不同）。这构成一层「看着绿、其实跑的是已删除的测试」的假绿面。
- `dist/src/` 另有 **3 个源已不存在的模块**：`adapters/model/budgetDegradeAdapter.js`、
  `benchmark/terminalbench/localContainerBackend.js`、`benchmark/terminalbench/taskEnvironment.js`
  （分别已改名为 `costBudgetDegradeAdapter.ts` / `nativeExecutionBackend.ts` / `taskEnvironmentReader.ts`）。
- 影响面之所以不止于本地：`package.json` 的 `files` 含 `dist/src`，`prepublishOnly` 只跑 `build`——**发布时陈旧模块会一起进 tarball**。

**建议**：`build` 前置清理（零依赖可 `node -e "fs.rmSync('dist',{recursive:true,force:true})"` 或 `tsc --build --clean`），
并把该动作纳入 CI；改动小、收益明确。**本盘点未擅自改动**（涉及构建/发布语义，应由你确认）。

### 5.2 🟡 arch:gate 仍有 1 条非阻断目录告警

`src/context/` 直接 `.ts` = **32**（阈值 30）。依赖方向违规 0、ports 纯度违规 0，故未阻断。属 C1 目录收敛的余量。

### 5.3 🟡 Rust 侧本会话零覆盖

`~/.rustup` 不存在、`cargo` 仅是无默认 toolchain 的 rustup 代理 ⇒ `cargo fmt/clippy/test` **本会话无法执行**
（CI 的 `rust`/`wasm` job 仍覆盖）。`target/` 内有 2026-09-19 的构建产物，说明历史上可构建。

### 5.4 🟡 一批工作成果尚未入库

13 改 + 15 未跟踪（含 3 个新 changeset）。按本仓纪律应「代码 / 文档 / changeset 分笔提交」并跑 pre-commit 门禁。
目前工作树状态是**可提交态**，但没有提交 ⇒ 一旦误操作（如误 `checkout`）会丢一批已验证工作。

### 5.5 🔵 已登记、无需动作的缺口

- 注入护栏**词法天花板**：`natural-language` / `source-code` / `config` 三类 recall **0%**，`tool-output` 75%
  （n=32 小样本，校准报告已明示**不可用于选型**）；
- 官方 SWE-bench Verified 满分口径、OS 沙箱真机（landlock/seatbelt/bwrap）、T4.4 真注入基准：均**挂起于外部条件**；
- 根目录 5 个 `.omni-alias-*.txt`（各 9B，`native*` 单测在 cwd 写下的探针残留；`.gitignore` 已用 `.omni-alias-*` 覆盖，不入库，可随手删）；
- `src` 内**无**遗留的 `TODO:`/`FIXME`/`HACK` 标记（仅 2 处出现在 `selfChecklist.ts` 的禁止标记检测表里）。

---

## 6. 建议的下一步（ROI 排序）

1. **收口在途批次**：按 changeset 分笔提交（`feat(exposure)` / `feat(guard)` / `perf(embed)` 三笔 + board 一笔），
   提交前跑 `audit:standard:delta`；当前证据已足够支撑提交。
2. **修 §5.1 的 dist 清理**（唯一实质隐患，工作量 < 0.5d，同时消掉「陈旧测试被跑」与「陈旧模块被发布」两个面）。
3. **补 Rust 门禁的真机证据**：装工具链后跑 `cargo fmt --check` / `clippy -D warnings` / `test --workspace`，
   把三行结果记入看板（本会话留空如实登记）。
4. **C1 余量**：`src/context/` 32 → ≤30，清零 arch:gate 最后一条目录告警。
5. 需要真绿灯的回归证据时，以 **CI（8 个 job：gate / web / test〔3 OS〕/ eval / security / rust / e2e / wasm）** 为准——
   本机沙箱因「禁管道子进程」永远无法复现全绿。

---

## 7. 与既有账目的对账

- 看板 §17 记载的各项数字（`plan()` 热路径 47.53→6.49 µs、embeddingPreload 9/9、enforcementMode 7/7、
  guardShadowMode 7/7、toolCatalogSnapshot 4/4、toolExposurePlanner 13/13、注入 recall 90.0%/FP 8.3%）**本会话逐项复算通过**；
- 看板 §17.5 记「全量单测基线 31 文件 / 74 例失败（环境性）」——本会话实测当前树恰为 **31 文件 / 74 例**，
  且**纯 HEAD 基线为 30 文件 / 73 例**（差异由基线 worktree 缺原生二进制 → 3 例转 skip 造成），互不矛盾；
- README 自我宣称的规模（441 TS / 5.5 万行）已**过期**：盘点时实测 **560 TS / 65,780 行**（收尾后 65,791 行，
  差值为本轮新增的模块头注释）；已在收尾中同步 README，见 §8。

---

## 8. 收尾闭环（同日执行，「余下问题全部清理收尾掉」）

> 本节记录 §5 各项的**处置与证据**；§5 保留「发现时」的原始描述不改，便于复核「改前 / 改后」。

| #   | §5 问题                                            | 处置                                                                                                                                                                                                | 提交      | 可证伪证据                                                                                                            |
| --- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------- |
| 1   | §5.1 `dist/` 从不清理（幽灵测试 + 陈旧模块可发布） | 新增零依赖 `scripts/cleanDist.mjs`（只清仓库内、末段为 `dist` 的目录，越界即拒绝退出 1）；`build`/`web:build` 编译前各自清理 `dist`、`web/dist`；`prepublishOnly` 补 `web:build`；新增 `clean` 脚本 | `76b186f` | 4 个陈旧文件全部消失；`dist` 单测 315→**314** 文件、通过 1940→**1936**（减少的正是 4 例幽灵用例）；失败集合逐文件不变 |
| 2   | §5.4 一批已验证成果未入库（13 改 + 15 未跟踪）     | 按 changeset 分笔入库：§17 三块能力（工具按需暴露 / 护栏三态化 + 快照绑定 / 嵌入预热）连同 5 个新测试、2 份度量报告、3 个 changeset                                                                 | `5d5646a` | `git show --stat 5d5646a` = 26 文件；新测试 40 例全绿；工作树该批清零                                                 |
| 3   | §5.2 `arch:gate` 目录告警（`src/context` 32 > 30） | rankVeto 一族整体下沉 `src/context/rankVeto/`（`index.ts` 域出口 + 三实现 + 5 处调用点改指 + 一层相对上跳修正）；文档头同步更新                                                                     | `3ed7c11` | `arch:gate` 输出 **目录告警 1→0**；`src/context` 直接 .ts **32→28**；rankVeto 单测 9/9                                |
| 4   | §5.5 运行残留 `.omni-alias-*.txt` ×5               | 删除仓库根 5 个探针残留（各 9B，`.gitignore` 已覆盖，不入库）                                                                                                                                       | 本笔      | 根目录 `Get-ChildItem .omni-alias-*` = 0                                                                              |
| 5   | §7 README 规模过期                                 | README 规模行按实测更新（`src` 560 文件/6.6 万行、`web/src` 104 文件/1.3 万行、`tests` 335 文件/3.8 万行、Rust 4.9 千行，日期 2026-09-22）                                                          | 本笔      | README 第 8 行                                                                                                        |
| 6   | §5.3 Rust 门禁本会话零覆盖                         | **如实登记，不假装跑过**：`~/.rustup` 不存在 + `cargo` 为无默认 toolchain 的 rustup 代理 + 环境无网络（`registry.npmjs.org` 不可达）⇒ 无法安装；CI `rust`/`wasm` job 仍覆盖                         | 本笔      | 见 §5.3 与看板 §18.5；本机证据留空                                                                                    |

### 8.1 收尾过程中被仓库自身门禁拦下的一处（教训留档）

提交 §17 批次时，`pre-commit` 的 `auditStandards --delta` **实跑**拦下了 `src/security/enforcementMode.ts`：
该文件主类是 `EnforcementModeResolver`，而「主类名 ≠ 文件名」对**新增文件**是阻断项。
按规则更名为 `src/security/enforcementModeResolver.ts` 并同步 5 处 import 后通过。
**这对看板 §16.5 那句「`audit:standard:delta` 通过（无暂存 .ts 时增量门禁通过）」是重要更正**——
它意味着该批次此前**从未真正过过这道闸**（无暂存文件时门禁是空跑）。

### 8.2 收尾后的稳定态（复跑结论）

| 项           | 收尾后实测                                                                                                                                                                                      |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 静态闸门     | `build` / `web:build` / `typecheck` / `lint` / `check --strict`（560 文件 0 违规）/ `arch:gate`（**目录告警 0**）/ `audit:config-wiring` / `audit:maturity` / `api:check` / `format:check` 全绿 |
| 逐文件单测   | 314 文件 / 1936 过 / **74 失败** / 17 skip（失败集合与改动前逐文件一致，全为沙箱 `spawn EPERM`）                                                                                                |
| Web 单测     | 236 例 / 234 过 / 2 失败（`e2e`、`e2e-cdp`，同为 `spawn EPERM`）                                                                                                                                |
| 集成 / smoke | 11 例 / 9 过 / 2 失败（真 serve+Chrome、自验证回环，同为环境）；`smoke` 全过                                                                                                                    |
| 工作树       | 收尾提交后**干净**（无未跟踪、无未提交改动）                                                                                                                                                    |
| 四笔提交     | 均由仓库自带 pre-commit 门禁**实跑**通过（含依赖方向、ports 纯度、接线完整性、ESLint 0 告警、Prettier 增量）                                                                                    |

### 8.3 仍未闭环（诚实边界，非本轮可解）

- **Rust 三闸门**（`cargo fmt --check` / `clippy -D warnings` / `test --workspace`）：本机无 toolchain 且无网络 ⇒ 需在
  有网环境或 CI 出证据；
- **官方 SWE-bench Verified 满分口径 / OS 沙箱真机 / T4.4 真注入基准**：挂起于外部条件（预算、Linux·macOS 真机、数据集）；
- **`main` 的 upstream 为 `[gone]`**（`mine/main` 已消失）：远端状态需联网确认，**未擅自改**；
- **注入护栏词法天花板**（`natural-language`/`source-code`/`config` 三类 recall 0%）：属能力缺口、已登记，非断链。
