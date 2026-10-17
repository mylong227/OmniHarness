---
'@mylong227/omniharness': patch
---

`serve` 增加**实例记录**（自描述、自愈、只删自己的），把 §8.17 那条"陈旧 serve 可存活 48 小时而无从识别"的
未修边界收掉；冲突提示随之能说出"上一个跑在这台机器上的是谁、什么时候起的、在哪个工作区"。

## 为什么还要一个文件（`/healthz` 不是已经报 pid 了吗）

§8.17 把"端口被占"从一句 `EADDRINUSE` 变成可行动诊断，但那条路只在**有人应答**时成立：
进程已死、端口被别人抢走、或用户根本不记得上次用的端口时，健康体什么都问不到。
而排障第一问恰恰是"上一个 serve 是谁、何时起的、在哪个工作区"。

## 改了什么

- 新增 `src/cli/serveInstance.ts`（`~/.omniharness/serve-<port>.pid`，**一端口一份**、JSON 自描述）：
  `announce`（先写临时文件再 rename，读者看不到半截 JSON）/ `read`（脏记录一律当"无记录"，fail-closed）/
  `isAlive`（**EPERM 视为存活**——权限不足 ≠ 进程不在）/ `retire`（**只删自己的**，核对 pid）/
  `sweep`（只清**已死**进程留下的记录）/ `describe`（缺字段如实省略，不补默认值）。
- 接线（`cliServerCmds`）：绑定成功后 `announce`；收到 SIGINT/SIGTERM 优雅收尾时 `retire`；
  启动与绑定失败两处先 `sweep`（自愈，并把清掉的记录如实打出来），再把**活着的**记录交给提示。
- `ServePortConflict.advice(port, holder, record?)` 新增可选的记录转述，并**明说与健康体一致/不一致**
  （不一致时以健康体为准，绝不替记录圆场；无记录且占用者是外人时一个字都不提记录）。
- **默认绝不杀任何进程**：记录不做互斥（真正的互斥是操作系统的端口绑定，任何自研锁都只会更弱），
  它的价值是"可识别 + 可清扫"。`--take-port` 的守卫（必须确认是自己人 + 正整数 PID）一字未改。

## 判据

- `tests/unit/serveInstance.test.ts`（6 例）：往返与脏记录（8 种坏输入）、**只删自己的**、
  sweep 两条分支（注入探针）、`isAlive` 的 EPERM/ESRCH 与非法 pid 不探测、
  `advice` 的四种一致/不一致组合、`describe` 缺字段不补默认值。
- `tests/unit/servePortConflict.test.ts` ⑤：接线断言随实参个数改为钉"调用形状 + 记录接线"
  （`announce`/`sweep`/`retire` 三处），并新增一条**正对照**（删掉 `retire` 调用必须检得出）。
- `tests/unit/servePortConflictE2E.test.ts`（真起进程，**hermetic**：`HOME`/`USERPROFILE` 指向临时目录）：
  ①-b 绑定成功后必须有记录且 pid/port 与在跑实例一致；② 冲突提示里必须出现"实例记录"与工作区；
  ③ 接管后记录必须**换成新持有者**（留下旧记录会让下次提示指向一个已死的 PID）。

## 实跑

`serveInstance` 6/6、`servePortConflict` 5/5、`servePortConflictE2E` 1/1（真起 3 个 serve 进程）；
`runGates` `fast` 10/10 + `typed` 2/2。
