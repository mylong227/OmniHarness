---
'@mylong227/omniharness': patch
---

CLI 冷启动**两段加载**：本地/低依赖子命令不再加载链顶（实测 `kv list` −25%，比值 7.3 → **5.3**）。

## 根因与修法

`exec.ts` 原先在慢路径上直接 `import('./execCli.js')`，而 `ExecCli` 位于单继承链**链顶**
（`… ← CliCompareCmds ← CliNativeCmds ← CliAgentCmds ← ExecCli`）⇒ 连 `kv list` 这种纯本地命令
也要付链顶（`Agent` / `Runtime` / 编排栈）的 ESM 解析成本。本机实测模块导入（含 ~75ms Node 启动）：
`cliDataCmds` ≈ 710ms vs `execCli` ≈ 990ms ⇒ 链顶约占 **280ms**。

修法利用一个 ESM 事实：**继承只向上依赖，加载祖先不会加载后代**。故新增
`src/cli/execLocal.ts`（`ExecLocal extends CliDataCmds`）持有 18 个本地命令的分发，
`exec.ts` 先加载它、只有链顶命令与默认 agent 路径才去加载 `execCli.js`。

## 为什么是**组合**而不是让 `ExecCli` 继承 `ExecLocal`

单继承链是线性的：`ExecCli` 必须继承链顶才能拿到 `goal`/`workflow`/`execute` 等链顶方法；
若改去继承链基（`ExecLocal`）就会**丢掉链顶**。故 `ExecCli` 持有一个 `ExecLocal` 实例并**先委托**
（`runLocal` 返回 `undefined` 即"不归我管"），判定**只有一份**（不是复制一遍分发条件）。

## 判据

- `cliStartupBudget.test.ts` 新增 ①-b 结构判据：`exec.ts` 必须动态加载链基并**真的调用**它、
  **不得静态 import** `execCli`；`execLocal.ts` 不得 import 链顶/`Agent`/`Runtime`；并带**正对照**
  （把链顶改回静态 import 必须被检出）。
- ② 的估计量从"3 次中位数"改为"3 次最小值"——**改的是估计量，不是预算（仍 ≤10）**：
  同一份代码在中位数口径下几分钟内给出 12.41 与 4.12 两个结果（分子分母同步漂移），
  而本判据量的是**固定装配成本**，噪声只会抬高它 ⇒ 最小值才是最少受干扰的估计（首版就已记录过
  "绝对秒数在并发下假红"的教训）。
- 实跑：`--version` 124ms / `kv list` 657ms ⇒ **比值 5.30**（改前 ~7.3）；连跑两次稳定。
  CLI 相关判据 7 文件 **36/36**；`runGates` `fast` 10/10 + `typed` 2/2。

## 诚实边界

链基那 6 个类**仍是单继承**——本次只把**链顶**从本地命令路径上摘掉。`license` / `capability` /
`evolution` 仍走链顶（它们本来就依赖链顶装配）。进一步收益要**按层拆**（每层一个可独立加载的分发），
属独立一片，已在看板 §8.22 登记（含"哪些层还没拆、怎么验收"）。
