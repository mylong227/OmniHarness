---
'@mylong227/omniharness': patch
---

MCP 适配器补齐协议能力：SDK 升至 1.32，**不再丢块**（G10，T1+T3）。

## T1：SDK 1.30.0 → 1.32.0（保守，不碰 v2）

`@modelcontextprotocol/sdk` 由 `^1.30.0` 升至 `^1.32.0`（实解 **1.32.0**）。白拿三处防护：
1.30.1 的 body/batch 尺寸上限、1.31.0 的 OAuth issuer 绑定、**1.32.0 的 `maxToolInputElements`**
（实测该符号确实在装上来的 1.32.0 里）。`LATEST_PROTOCOL_VERSION` 升级前后均为 `2025-11-25`
⇒ **协议版本断言不破**（本仓测试断言的是自家常量，非 SDK 常量）。

## T3：两处**静默丢块**（两条客户端路径各有一处，一并修）

1. **非文本块被塌成空文本**：SDK 适配器原把 image/audio/resource_link/resource 一律收敛为
   `{type:'text', text:''}` ⇒ 远端返回一张图，模型侧只看到**空白**且无从知道那里本来有东西；
   手写回退实现虽原样透传，但网关只读 `.text` ⇒ **结果里同样是空段**。
2. **`structuredContent` 被整块丢弃**（两条路径都丢）——远端按 `outputSchema` 返回的机器可读结果，
   模型完全看不到。

修法：

- 新增 `src/mcp/mcpContentBlocks.ts`（`McpContentBlocks`）把内容块归一化**收成一处**：文本块原样保留；
  图/音转述为含 **MIME 与体积**的可读文本；资源链接/内嵌资源转述含 **URI/名称**；未建模形状转述为
  **JSON 摘要（截断 200 字符）**——**绝不返回空串**；原始块保留在 `raw`。
  （收成一处的理由：两条路径此前各写一半，漂移会让同一条远端响应在不同路径下给出不同文本且不报错。）
- 端口 `McpContentBlock` 联合类型 + `McpCallToolResult.structuredContent?`（加法式；两种块都有 `text`
  字段 ⇒ 既有 `content.map(c => c.text)` 调用点**零改动**仍编译）。
- 网关 `toToolResult` 把结构化输出渲染为带标签 JSON 追加进工具结果（模型看得见结构化字段）。

## 判据（`tests/unit/mcpAdapterRichContent.test.ts`，5 例，离线零 key）

走**真 SDK 适配器 + 真 stdio 子进程**（`tests/fixtures/mcpEchoServer.ts` 新增 `structured`/`rich` 两个工具）：
① SDK 1.32 下真 stdio 握手与列举仍通（协议版本断言不破）；② 图/资源链接转述**非空且可辨识**
（含 MIME、URI），原始块保留；③ `structuredContent` 原样透出，且**经网关端到端**渲染进结果文本；
④ `isError` 仍如实分流 `ok:false` 且错误文本不丢；⑤ 未建模形状也转述为含类型名的非空摘要。

**变异测试**：把归一化改回"非文本块塌成空文本" ⇒ ②③⑤ **三例全红**；回滚后 5/5 绿。

**连带同步**：夹具新增两个工具 ⇒ `mcp.test.ts` 里"桥接工具清单"的既有断言同步更新（并注明原因）；
该文件其余用例（网关端到端桥接、isError 收敛、启动失败隔离）全过。

## 验证

`tsc --noEmit` 零错误；`npm test` 全绿（新 5 例 + 既有 MCP 测试 41 例全过）；
`arch:gate` / `check --strict` / `lint`（0 告警）/ `audit:config-wiring` / `audit:maturity` /
`check:doc-links` / `api:check` / `audit:standard:delta` / `rust:test` / `web:test` 全绿。

## 口径边界（如实登记）

- 富内容依然**只以文本转述**进入工具结果通道（本仓工具结果是文本；把二进制塞进上下文既超预算也无必要），
  但**不再静默**：转述里写明类型/MIME/体积，且 `raw` 保留了原始块供能处理富内容的调用方使用。
- 报告 T2（planner 上 BM25 检索优先 + `tools/list` 确定性排序）**不在本项范围内**，未做。
