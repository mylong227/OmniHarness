---
'@mylong227/omniharness': minor
---

Windows **双击一键启动**：仓库根新增 `start.cmd`（= `npm start -- --open` 的友好外壳），`npm start` 新增 `--open`（**就绪之后**才打开浏览器）。

## 之前是什么样（实测）

`npm start` 已经是"构建服务端 + 构建前端 + 起服务"的单一入口，但**双击场景**下它有三处不管：

1. `node` 不在 PATH 或版本低于 `engines.node`（22.14.0）时，窗口一闪而过，只剩"我双击了但什么都没发生"；
2. 双击后还得自己去浏览器里敲地址；而"起了就开页"又会**白屏**（首次 `npm start` 要现编前后端）；
3. 停止 / 构建失败 / 端口被占，结论都留在窗口里，窗口一关就没线索。

还有一类**更隐蔽**的骗法：端口上其实是**别的进程**（两天前的旧 `serve`、或别人的 HTTP 服务）——
此时打开浏览器看到的是**别人的页面**，用户会以为是本项目的工作台。

## 现在

- **`start.cmd`**（仓库根，**纯 ASCII + CRLF**）：双击即 `npm start -- --open`，参数原样透传
  （`start.cmd --port 9000` / `--no-build`），并在窗口里留下结论后再 `pause`。
- **`--open`**：轮询 **`/readyz`**（不是恒 200 的 `/healthz`）直到真的就绪，再打开 `http://127.0.0.1:<port>`；
  `foreign`（端口上有响应但不是本程序的健康体）时**立即停**且**不开页**，如实说明；
  超时同样只如实报告，不静默。
- **`OMNI_NO_OPEN=1`**：无人值守 / 自动化里只压住**弹窗**这一步，"等待 + 就绪报告"照旧（那才是自动化要的事实）。
- **退出码说人话**：区分"按了 Ctrl+C"（130 / Windows 的 3221225786）与"失败退出"。
- 上述纯逻辑落在 `scripts/lib/launchReadiness.mjs`（零 I/O、零依赖，可单测）；
  `.gitattributes` 为 `*.cmd` / `*.bat` 单独声明 `eol=crlf`（全仓其余文本仍 `eol=lf`）——
  LF 单换行会让批处理的 `goto` / 标签跳转不可靠。

## 判据

`tests/unit/launchReadiness.test.ts`（8 例，离线可跑，全部注入 `probe` / `sleep` / `now`）：

- 端口解析（两种写法 + 非法/缺失回落缺省，含正对照）；
- **端口缺省值不得自成一源**：与 `src/cli/cliServerCmds.ts` 的 `--port ?? 8787` 机械核对；
- 就绪分类穷尽且 **fail-closed**：非 JSON 的 200 / 缺 `status` 的 200 / 404 一律不得判 `ready`；
- 轮询节奏可预期（已就绪即收工；超时分支尝试次数精确断言，防死循环）；`foreign` 是终局（调用次数 = 1）；
- Windows 打开命令必须带**窗口标题占位参数**（否则带查询串的 URL 会被 `start` 当标题）；
- 退出文案：Ctrl+C 与失败分得开，且失败文案不给"失败了"就打住；
- **接线**：`--open` 由启动入口消费、**绝不透传给 serve**（未知旗标 fail-closed）；
- `OMNI_NO_OPEN=1` 的压制分支必须排在 `waitForReady` **之后**、`spawn` **之前**。

端到端实测（本机，真跑）：`start.cmd --no-build --port 21999 --mock` ⇒ `/readyz` 200、
窗口打印「✓ 工作台已就绪：http://127.0.0.1:21999」、`OMNI_NO_OPEN=1` 下不弹窗而如实报告。
