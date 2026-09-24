---
'omniharness': patch
---

**Windows 带引号参数的 shell 命令修复（审计 §1.9）**：`cmd /d /s /c` 与 Node 的 argv 转义两层叠加，把带空格路径/引号参数**粘成一个参数**（实测报错 `Cannot find module '...\"...\"'`）。修法是给命令整体加一层引号并让 spawn **原样传递 argv**。

- **根因**：`ShellInvocation.args()` 的 Windows 形态是 `['/d','/s','/c', command]`。`cmd.exe` 的 `/s`
  会按自己的规则剥引号并重解析命令行，而 Node 在拼 Windows 命令行时也会对 argv 转义一次；
  命令自带引号（带空格路径、`-e "..."`）时两层规则错位。
- **实测选型（探针，脚本路径与文件名都含空格）**：旧形态 ❌、`/d /c` + 原文 ❌、
  **`/d /s /c` + 整体加引号 + `windowsVerbatimArguments: true` ✅**（`/s` 恰好剥掉我们加的那层）。
- **修法**：cmd 形态改为 `['/d','/s','/c', '"' + command + '"']`；新增
  `ShellInvocation.needsVerbatimArgs()`，并在**三个 spawn 点**（`shellProcessRunner` /
  `backgroundJobRegistry` / `shellInteractiveExecutor`）统一传 `windowsVerbatimArguments`——
  避免「前台修了、后台没修」的口径分叉。**POSIX 形态逐字未变**（`['-c', command]`）。
- **回归矩阵**（`tests/unit/shellProcessRunner.test.ts` 新增 3 例）：① 含空格路径的脚本与其参数
  **逐字到达子进程**（直接断言子进程收到的 argv）；② 引号内含空格的参数不被拆开；
  ③ **引号内的 `&` 不得被执行成第二条命令**。
- **反向验证**：临时改回旧形态重跑，矩阵立刻红（报错与当初探针一致：`Cannot find module '...\"...\"'`）。
- **兼容性复验**：`echo a & echo b` → `a b`、`echo "a&b"` → 字面量、`echo %OS%` → `Windows_NT`、
  管道 / `1>&2` 重定向 / `node -e "console.log(1+1)"` / 引号内套引号 —— 全部正常；
  **不含引号的命令行为不变**（这正是该缺陷长期未被发现的原因），受影响的是「参数带引号 / 路径含空格」类。
- **一处既有断言随语义更新**：`ptyCapability.test.ts` 的 cmd 形态 argv 期望改为带整体引号的形态；
  `shellInteractiveTool.test.ts` 的 inherit 形态断言由「只断末位」改为**断言整段 argv 形态**
  （两者都附原因注释，均为收紧而非放宽）。
- **覆盖率门禁容差按实测证据调整（工具）**：本轮又出现两个**未改动**文件超容差下浮
  （`jsonFileKv` −2.41、`memoryStackAssembler` −1.59），用「把新增测试文件从全量集合里去掉即精确回到基线」
  的排除实验确认是**度量抖动**（第四次同型）。故漂移容差 1 → **2.5 点**，四次实测幅度表写进门禁注释；
  同时写明诚实边界：小于 2.5 点的真实回退与噪声无法可靠区分，靠「棘轮只升不降 + 下调须先做排除实验」兜底。
  本轮 `--dump-baseline` 棘轮**保留 6 个更高基线、未下调任何一个**。
