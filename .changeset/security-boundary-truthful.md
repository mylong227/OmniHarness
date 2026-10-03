---
'@mylong227/omniharness': patch
---

安全边界**如实标注** + 记忆信任档收紧（G5，P0 最后一项）。

## 问题（看板 §8.5 登记的三处「声明强于实现」）

1. 默认沙箱档是 `policy`——纯 TS 黑名单 + 路径白名单，**无内核强制**；
2. Windows「OS 级」后端调 `CreateRestrictedToken(..., 0, null, 0, null, 0, null, …)`——
   三个 restricting-SID 计数**全为 0** ⇒ 只削减特权 + Job Object 限额，**无文件/网络拒绝语义**；
3. `networkEgressGuard` **只包 `globalThis.fetch`** ⇒ shell 子进程（`curl`/`certutil`/原生 socket）完全绕过；
   且 `memory_search`/`recall` 与 `read_file` 同归 `file` 信任档（阈值 2）。

**用户可感知后果**：模型若被注入说服，`shell` 里的下载/外联命令在本机**不会**被 fetch 守卫拦住。

## 改动（把"真实能力边界"变成数据与诊断，而不是继续声称已隔离）

1. **记忆信任档收紧**：`TrustTier` 新增 `memory` 档（阈值 **1**，与 `external` 同级），
   `memory_search` / `recall` 从 `file`（阈值 2）移入。理由写在类头 JSDoc：
   ① **持久性放大**——工作区文件是"读一次、用完即过"，记忆是**跨会话持久**的，一次注入写进去、
   之后每次召回都带回来；② **来源不可追溯**——记忆由抽取器从历史总结，可能是 `web_search`/`web_fetch`
   的产物，召回时无法区分"用户亲口说的"与"从外部网页读来的"。放宽只能经
   `promptInjectionGuardThresholds` **显式**覆盖。
   同时 `isUntrusted()` 改为与阈值**同源**实现（`threshold ≤ 1`），杜绝"阈值收紧了、它却说可信"的分叉。
2. **网络守卫自述常量**：`NetworkEgressGuard.COVERAGE`（`surfaces: ['globalThis.fetch']`、
   `shellSubprocessGuarded: false` + 依据），供诊断**同源**转述。
3. **能力表订正**：`SandboxCapabilityTable` 的 `restricted` 条目删去"Windows 上真 OS 级隔离由 Rust
   RestrictedToken 提供"这句暗示，改为如实说明它只削减特权、并指出要真正隔离需 AppContainer + DACL 或
   WSL2 内 bubblewrap/landlock。
4. **`doctor` 增「安全边界」段**：`SecurityBoundary`（隔离强度/依据/生效档/是否内核强制/网络守卫覆盖面
   /注入护栏阈值），值全部取自上述单一事实来源，本机真实输出：

   ```
   隔离强度     : L2（生效档 policy；内核强制=否；后端真机可达=是；Windows 受限令牌只削减特权与资源（restricting-SID 计数为 0），无文件/网络拒绝语义）
   网络守卫覆盖 : globalThis.fetch；shell 出网被拦=否
   注入护栏     : off（弱证据阈值 external=1 / unknown=1 / memory=1 / file=2 / local=3）
   ```

   `ToolOutputTrust.thresholds()` 新增（运行期联合类型不可枚举，由此集中给出，避免诊断侧另抄一份）。

5. **文档订正**：`docs/compliance.md` 沙箱行原写「**OS 级隔离 ✅**」⇒ 改为如实口径并降级为 ⚠️。

## 判据（`tests/unit/securityBoundary.test.ts`，5 例，离线零 key）

① 默认档必须报 `L2` 且 `kernelEnforced=false`；② 工作区配 `bwrap` 时，**只有"真机可达 + 内核强制"才升 L3**，
不可达时留在 L2（"配置里写了" ≠ "内核真的在拦"）；③ 网络守卫必须自述"只覆盖 fetch、不覆盖 shell"；
④ 记忆档阈值 1（与 `external` 同级）且 doctor 可见；⑤ 能力表不得再暗示受限令牌提供 OS 级隔离。
另同步 `tests/unit/toolOutputTrust.test.ts`（新增记忆档映射/阈值/标签/不可信判据）。

**变异测试**：移除 `fromToolName` 里的 `memory` 档判定（回落 `file`）⇒ ④ **变红**；回滚后全绿。

## 遗留（如实登记，不在本项范围内）

**隔离能力本身没有变化**：本变更只让声明与实现一致。要真正达到 L3，需 AppContainer + 宿主路径 DACL
或 WSL2 内 bubblewrap/landlock（报告 §3.5 的结论），属独立工程项；`shell` 出网收口同理——
靠命令黑名单是**可绕过**的，写进去只会制造假安全，故不在此处塞一个"看起来能拦"的开关。
