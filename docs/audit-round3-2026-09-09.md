# OmniHarness 第三轮盘点——两轮 UI 对齐后的剩余升级空间

> 日期：2026-09-09 23:20 ｜ 方法：技能 `codebase-maturity-audit`（双代理扫描因限流 429 未成行 → 主代理按铁律逐项亲自 grep/Read 钉深度）
> 诚实边界：`src/core/stepRunner.ts`、`src/core/turnRunner.ts`、`src/adapters/live/**`、`src/ports/toolInputSink.ts` 正被 Agent Loop V2 会话并发重写（23:19 仍有写入），**本报告不对热区下结论**。所有数字均实测。

---

## 0. 一句话结论

**有，但性质变了。** 前两轮已把「一票否决级」（CI/单测/a11y/安全）和 Codex 桌面端四块硬骨头清零；剩下的空间集中在三类：**① 新增代码自己的测试债**（本轮引入的 150+ 行后端审查逻辑 0 测试、web 覆盖率仅 3%）、**② 长会话性能债**（事件列表无界增长）、**③ 架构级大件**（应用内浏览器/云端委派/SSH——建议单独立项，不混入冲刺）。

---

## 1. 规模实测（两轮改造后）

| 区域 | 基线（第一轮审计） | 现在 | 变化 |
|---|---:|---:|---|
| `web/src` | 36 文件 / 5,498 行 | **39 文件 / 6,521 行** | +3 文件 / +1,023 行（+19%） |
| web 测试 | 0 | **1 文件 / 14 用例** | 覆盖 `textUtils.ts` 1/39 ≈ **3%** |
| 后端新增（审查 RPC） | — | appServer.ts +~180 行 | **0 测试** |
| `.omni*` git 污染 | — | 已修复（本轮，见 §4） | — |

---

## 2. 亲自核实：确认没问题的项（防止下轮重复误报）

| 检查项 | 结论 | 证据 |
|---|---|---|
| activeTurns 异常路径泄漏 | ✅ 无泄漏 | `appServer.ts:560-570`，`try/finally` 包裹，异常也清理 |
| git 命令注入 | ✅ 无 | 全部 `spawnSync('git', [数组参数], …)` + `--` 分隔符，不经 shell |
| 路径穿越 | ✅ 防护正确 | `safeRepoPath`（appServer.ts:247）：拒绝对路径/盘符 + `resolve→relative` 前缀校验，6 处调用点全接入 |
| UI XSS | ✅ 无 | `web/src` 0 处 innerHTML/dangerouslySetInnerHTML，注释明确「不用 innerHTML」铁律 |
| 评论文件读改写竞态 | ✅ 单线程内无竞态 | `loadDiffComments` 用 `readFileSync` 同步 IO，handler 同步完成（代价：同步 IO 阻塞事件循环，文件小可接受） |
| CI web 门禁 | ✅ 在 | `ci.yml:30` `web` job（build + 14 单测） |

---

## 3. 新发现的差距（前两轮报告未覆盖）

### P1（建议下一轮优先）
1. **新增代码自己的测试债**：`changes.stageHunk/revertHunk/stageFile/revertFile`、`changes.comments.*`、`checkpoint.*`、`activeTurns→sessions.list` 标注——**全部 0 单测**（`grep tests/` 空）。web 端 `CommandPalette`/`RollbackTab`/`ChangesTab` 交互逻辑、`ApiClient` 新方法同样无覆盖。**这批代码安全敏感（git 写操作 + 文件持久化），恰恰最该有测试。**
2. **长会话性能债**：`App.ts:202` `setEvents(prev => [...prev, ev])` **无界增长**，无截断/虚拟化；每条 SSE 事件触发全列表 re-render。千级事件会话会明显卡顿。成熟方案：窗口截断（保留最近 N 条 + 「加载更早」）或 react-window 式虚拟化。

### P2
3. **UI 状态刷新丢失**：当前 pane、diff 草稿、@mention 偏好均不入 localStorage；服务端进程重启后 `activeTurns` 清零属合理，但 UI 侧无「会话恢复中」提示。
4. **同步 IO 在 RPC 路径**：评论读写用 `readFileSync/writeFileSync`，量大后阻塞事件循环（现量级可接受，记账待换 async）。

### 架构级（维持原判，单独立项）
5. 应用内浏览器 + 页面级视觉反馈、云端委派/Best-of-N、SSH 远程、多形态跨端续接——均需后端配套，不混入 UI 冲刺。

### 前两轮已记录、仍开着的账（不重复展开）
UI e2e/视觉回归；后端零测试模块（lsaRecall/cliDataCmds/configBuilders/registrySources）；Rust 测试未进 CI；提示注入仅观测；OTel/Prometheus；artifact 画廊；定时任务；审批 policy 持久化。

---

## 4. 本轮已修

- `.gitignore` 补 `.omni-checkpoints/` 与 `.omni/`（检查点快照 + 行内评论均为用户数据，`git check-ignore` 已验证生效，git status 污染清零）。

---

## 5. ROI 待办表

| 优先级 | 项 | 成本 | 说明 |
|---|---|---|---|
| 1 | 新增后端 RPC 单测（changes.*/checkpoint.*：合法/穿越拒绝/未跟踪文件/未找到评论四类路径） | 中 | 安全敏感代码的裸奔，等 Agent Loop 会话收工后做（appServer.ts 非热区，可并行） |
| 2 | 事件列表截断/虚拟化（App.ts `setEvents`） | 中 | 长会话体验悬崖，纯前端改动 |
| 3 | UI e2e 最小集（playwright：发任务→流式→审批→diff 审查一条龙） | 中 | 已开两轮的账，交互复杂度上来后价值陡增 |
| 4 | web 组件级测试补齐（CommandPalette 键盘导航 / ChangesTab 评论增删） | 中 | 3% 覆盖率对 39 文件不成比例 |
| 5 | 后端零测试四模块（旧账） | 中 | 纯逻辑易测 |
| 6 | Rust 测试进 CI / 提示注入可配置阻断 / OTel 导出（旧账） | 高 | 生产对接期 |
| 7 | 应用内浏览器 / 云端委派 / SSH | 架构级 | 单独立项 |

---

## 6. 总评

两轮对齐后，**「对标缺口」型问题基本清零**——剩余空间不再是「缺功能」，而是「新代码的自举质量」（测试 1 轮落后于功能 2 轮）与「规模化体验」（长会话）。这是健康信号：该修的修完了，剩下的是养代码。下一步最划算的动作是**给这轮新写的 git 写操作补上单测**——安全敏感 + 逻辑分支多 + 不依赖浏览器，成本收益比最高。
