---
'@mylong227/omniharness': patch
---

`doctor` 退出码语义**明确化 + 判据对齐**：语义本身未改（有问题项即非零），改的是把它从"藏在调用点的一行三元"
变成**唯一实现 + 两向判据**，并修掉一条把"本机健康"写进契约的假红判据。

## 语义（未变，但现在有名字、有判据、有文档）

`0` = 报告里没有问题项；`1` = 至少一项。

为什么有问题要非零：诊断是**排障与 CI 的入口**。「跑了、发现问题、却退出 0」会让 `doctor && 下一步`
把坏环境当好的继续用，而人只会在输出里看到一行 WARN。这与 `cliSystem.test.ts`（无 key ⇒ 非零）
和 F1「过期降级但不停摆」是同一条纪律的两面：**能判定的失败必须让调用方判得出来**。

- 新增 `DoctorRunner.exitCode(report)`（实例 + 静态门面），`cliServerCmds.runDoctor` 改为调用它；
- `docs/CLI_REFERENCE.md` 的 `doctor` 行补上这条语义（此前**全仓文档零处**写明退出码）。

## 修掉的假红判据（本机实测过）

`tests/unit/cliLocalCommands.test.ts` ① 旧断言写死 `doctor` 必须 `exit 0` —— 那是把"本机健康"写进了契约：
缺插件目录、无 OS 沙箱后端都是**合法本机状态**，而 doctor 会如实报出来并以 1 退出。
本机（Windows 非提权、无 `~/.omniharness/plugins`）**必然假红**，且已用洁净树对照证明与本轮改动无关。
现改为钉**一致性**：`code === 0 ⇔ 报告含 [OK] 未发现健康问题`，`code === 1 ⇔ 报告含 [WARN] 发现 N 项问题`；
另加一条**确定性的**反向判据 ①-b（`--config` 指向不存在的文件 ⇒ 必有配置问题项 ⇒ 非零）。
`scripts/realRunSmoke.mjs` 里同一处假设也一并改正（旧文案"带配置 ⇒ 应 exit 0"）。

## 判据

- `tests/unit/doctor.test.ts` 新增：用**合成报告**钉死映射两个方向（`issues: [] ⇒ 0` / `issues: ['x'] ⇒ 1`），
  并带**正对照**（只改 `issues` 一个字段，退出码必须跟着变 ⇒ 防"恒 0 或恒 1"的退化实现）；
  再断言真跑出来的报告与其自身问题清单一致。合成报告的理由写在注释里：拿机器健康当判据就是假红之源。
- `cliLocalCommands.test.ts` ①②-b、`cliSystem.test.ts`（无 key ⇒ 非零）全部真跑 CLI 子进程。
- 实跑：`doctor` / `uiBaseline` / `cliLocalCommands` / `cliSystem` 四文件 **28/28**；`runGates` `fast` **10/10**。
