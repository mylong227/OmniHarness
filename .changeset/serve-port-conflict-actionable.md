---
'@mylong227/omniharness': minor
---

`serve` 端口被占时不再只回一句 `EADDRINUSE`：给出**可行动诊断**，并支持**显式接管**（`--take-port`）。

## 之前是什么样（实测教训）

`serve` 绑定失败时只把 Node 的原始错误抛给用户：

```
omniharness: 启动失败：listen EADDRINUSE: address already in use 127.0.0.1:8787
```

实测后果：一个**两天前**启动、后台活了 48 小时的旧 `serve` 占着 8787 ⇒ **每次** `npm start` 都只回这一句。
用户既不知道占用者是谁、也不知道有哪几条让路的路，只能反复重试。这不是运气问题，是**报错不可行动**。

## 现在

`/healthz` 健康体新增 `pid`（跨平台、零依赖就能认出"占着端口的是不是另一个 OmniHarness serve、是哪一个"），
绑定失败时输出：

```
omniharness: 启动失败：listen EADDRINUSE: address already in use 127.0.0.1:8787
端口 8787 已被**另一个 OmniHarness serve** 占用（PID 15248，已运行 2 分钟）。
三条出路：
  ① 换端口启动：omniharness serve --port 8788（或 npm start -- --port 8788）
  ② 停掉那个旧服务：Stop-Process -Id 15248        # 类 Unix：kill 15248
  ③ 让本次启动直接接管：omniharness serve --take-port（**仅当占用者确认是 OmniHarness serve 时**才终止它；本程序不会杀别的进程）
```

**默认行为一概不变**：不杀任何进程，退出码 1。原始错误仍然保留（便于检索/搜索引擎命中）。

**`--take-port`（新旗标，已登记进 `knownFlags`）**：显式请求接管 —— 仅在"占用者的 `/healthz` 自述
`status=ok` 且带正整数 `pid`"时终止它，等端口释放后重试一次绑定。**分类 fail-closed**：
有响应但形状不符（缺 `pid` / `status` 非 ok / 非 JSON / 4xx）一律判为"别人的进程"，
既不提示接管、`--take-port` 下也**拒绝动手**。

## 判据

- `tests/unit/servePortConflict.test.ts`（4 例）：三分类（自家人 / 别人 / 空闲）、
  形状不符一律 fail-closed（4 种冒名响应 + 非 JSON + 4xx）、提示必须给三条出路且**对别人的进程不提接管**、
  `takeOver` 只对"自家人 + 正整数 PID"调 kill 且**拒绝路径绝不调用 kill**（杀手间谍）、接线（附正对照）。
- `tests/unit/servePortConflictE2E.test.ts`（1 例，真起进程）：A 占端口 → B 同端口失败且点名 PID、
  给出三条出路、**A 仍活着**（默认不杀）→ C 带 `--take-port` **接管成功且 A 已退出** →
  占用者是普通 HTTP 服务时**即便带 `--take-port` 也拒绝接管**并如实报"非本程序的进程"。
- 顺带修正一处分类 bug（判据当场抓到）：`/healthz` 回了非 JSON 时，首版因 `json()` 抛错落进
  "连不上 ⇒ 端口空闲"分支 —— 实际是**有人占用**。现在只有"连不上"才算空闲。
