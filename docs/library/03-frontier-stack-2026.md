# 03 · 前沿：工程栈 2026（TS / Node / 供应链）

> 归档 2026-09-12 | 只记**对本仓库产生实际约束**的栈事实。

---

## 1. TypeScript 7.0：编译器用 Go 重写

**事实（可核实）**：
- 2026-04-21 发布 Beta（`@typescript/native-preview@beta`，二进制名 `tsgo`）；2026-06-18 发布 RC（`npm i -D typescript@rc`，二进制名回归 `tsc`）；**2026-07-08 正式 GA**。
- 内部代号 **Project Corsa**（新 Go 实现），旧 JS 实现称 **Strada**。**是端口（port）不是重写**——逐文件移植，保留**完全相同的类型检查语义**，因此可作生产级。
- 微软称常约 **10× 更快**（原生执行 + 共享内存并行）。代表性实测（官方给出，单位秒）：

| 项目 | TS 6 | TS 7 | 加速 |
|---|---|---|---|
| vscode | 125.7 | 10.6 | 11.9× |
| sentry | 139.8 | 15.7 | 8.9× |
| bluesky | 24.3 | 2.8 | 8.7× |
| playwright | 12.8 | 1.47 | 8.7× |
| tldraw | 11.2 | 1.46 | 7.7× |

**新增并行控制**：`--checkers N`（默认 **4** 个类型检查 worker）、`--builders N`（project references 并行构建）、`--singleThreaded`。二者相乘（`--checkers 4 --builders 4` ⇒ 最多 16 个 checker），**小 CI runner 上会打满 CPU/内存**。

**升级会「就地炸掉」的配置（必须逐条核对）**：
1. `rootDir` 默认变为 `./`（源码在 `src/` 的仓库需显式设 `rootDir: "./src"`，否则输出结构变化）；
2. `types` 默认变为**空数组**（依赖 node/jest 全局类型的必须显式列出）；
3. 以下**移除**：`target: es5`、`downlevelIteration`、`moduleResolution: node/node10/classic`、`module: amd/umd/systemjs/none`、`baseUrl`、`esModuleInterop:false` / `allowSyntheticDefaultImports:false`。

**关键限制**：**7.0 没有稳定的 programmatic API**，要到 **7.1**。因此依赖 compiler API 的工具（**typescript-eslint**、ts-morph、自定义 transformer、Volar/Vue/Astro/Svelte 的语言服务）**必须继续用 TS 6 API**。官方过渡包：`@typescript/typescript6`（提供 `tsc6` 入口与 6.0 API 再导出）。

**推荐过渡姿势**（放在 `package.json`，让 `typescript` 名指向 6 API、7 用别名装）：

```json
{
  "devDependencies": {
    "@typescript/native": "npm:typescript@^7.0.2",
    "typescript": "npm:@typescript/typescript6@^6.0.2"
  }
}
```

**对本仓库的影响（推论）**：
- 本仓库是**纯 TypeScript**（无 Vue/Astro/Svelte 嵌入语言服务），且**依赖 `typescript-eslint`**（铁律门禁 `no-explicit-any`/`explicit-member-accessibility` 都靠它）。
- 因此正确路径是：**先升到 TS 6.0 并把废弃配置清干净**（这一步零风险且立即受益于更严格默认值），**再单独在分支上把 `tsc` 换成 7.0**（仅用于 `--noEmit` 与构建），而 **eslint 侧继续用 6 API**。
- 收益：本仓库 392 文件 / 3.4 万行，量级不大，绝对提速有限（秒级），**但 `--watch` 重建与 CI 反馈更快**；真正的价值在**类型检查不再慢到被团队绕过**。
- **不要在 7.1 出来前把 `typescript` 包名整体切到 7**——会打断 eslint 门禁链。

---

## 2. Node.js 26

**事实**：
- **Temporal API 默认启用**；V8 升到 **14.6**。
- 新增 `--experimental-package-map`：从静态 JSON 解析包，不再遍历 `node_modules`——**对消除幻影/损坏 peer 依赖有用**。
- `node:quic` / HTTP/3 仍**高度实验**（ALPN 自动激活 HTTP/3）。
- 释放计划（release schedule）调整；社区讨论**内置 OpenTelemetry** 支持；统一异步可迭代 Streams API。
- **npm 的 install scripts 正在转为 opt-in**（供应链攻击应对）——`postinstall` 默认不再执行是明确趋势。

**对本仓库的影响（推论）**：
- 本仓库铁律是**零运行时依赖**，因此 Node 升级的收益主要是**语言能力**（Temporal 让时间处理不再依赖第三方；对记忆时间维度、审计时间戳友好——直接服务 02 卷的 T1/L1）。
- 供应链：本仓库依赖极少（仅 `@huggingface/transformers` 与 devDeps），**攻击面天然小**。但应**跟随 install scripts opt-in 趋势**，在 CI 与文档中显式声明 `--ignore-scripts` 可行性。
- HTTP/3：`src/a2a/httpA2aTransport.ts` 目前走 HTTP/1.1（或 2），**不建议**在实验阶段迁到 `node:quic`。记录为「远期观察」。

---

## 3. 其他栈信号（观察，不采纳）

| 信号 | 内容 | 本仓库立场 |
|---|---|---|
| **Bun 用 Rust 重写** | 进展不明（PR 尚不稳定） | 观察；本仓库以 Node 为准 |
| **Rspack 替代 Webpack** | 构建时间约 -50%（厂商自报） | 观察；本仓库前端构建轻，收益小 |
| **TanStack 组织级加固** | npm 事件后的安全实践 | 可借鉴到本仓库供应链策略 |
| **Sentry 为 44 个库加 TracingChannel** | 可观测性标准化 | 与本仓库结构化日志/traceId 方向一致 |

---

## 4. 本卷结论：三条栈决策

| 决策 | 内容 | 理由 |
|---|---|---|
| **S1** | 先升 **TS 6.0 + 清废弃配置**，`rootDir`/`types` 显式化 | 零风险、立即受益、为 7.0 铺路 |
| **S2** | TS 7.0 只用于 `tsc --noEmit` / 构建，**eslint 侧保持 6 API** | 7.0 无稳定 programmatic API，否则会断门禁链 |
| **S3** | 跟随 npm install scripts **opt-in**，CI 显式 `--ignore-scripts` | 供应链安全，且本仓库依赖本就极少 |

**诚实边界**：本仓库代码量（3.4 万行）远小于上表基准项目，**10× 提速在绝对时间上是秒级收益**，不应作为升级动机的主诉求；主诉求是**「类型门禁不再被绕过」与「配置现代化」**。

---

## 参考

- Microsoft, Announcing TypeScript 7.0（RC/GA 公告）；TypeScript 7.0 Beta（2026-04-21）
- InfoWorld《Revving up Microsoft's 10x faster TypeScript 7》
- Node.js Digest（Node 26 / Temporal 默认启用 / `--experimental-package-map` / node:quic）
- TypeScript 7.0 迁移实测笔记（tsconfig 新默认值、`--checkers`/`--builders` 乘数效应）
- 各项目实测倍数为**官方自报**，应在本仓库自测后再引用
