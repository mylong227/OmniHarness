---
'omniharness': patch
---

修「默认数据不随包发布」与「SSRF 策略在探测路径上不生效」两处配置化收尾缺陷，并新增一条门禁不变量。

**缺陷 1（发布即不可用）**：`package.json#files` 未含 `defaults`，而 `defaults/README.md` 与迁移说明都已写明
「必须含 `defaults`，否则安装后启动即报错」——**声明与事实不符**（自我宣称未落实）。npm 包会缺
`defaults/*.json`，安装后**启动即抛错**（`builtinDefaults.json()` 读不到数据，fail-closed）。
已修：`files` 加入 `defaults`。

**缺陷 2（配了却不生效）**：`server/services/providerProbe.ts` 两处
`assertNotSsrf(url, defaultSsrfOptions())` 写死默认档 ⇒ 用户在 `omniharness.json` 配的 `ssrfPolicy`
在**厂商探测路径**上不生效（与本仓反复登记的「声明未接线」同型）。已修：新增
`ssrfOptionsFor(policy)` 统一入口（默认档 + 注入策略，避免「只传 policy ⇒ 本地端点被误拦」的 E2 形态），
`fetchModelsEndpoint` / `probeViaChat` / `probeProvider` 增加可选策略入参，
`ModelCatalogService` 的两个探测点注入 `resolveSsrfPolicy(file.ssrfPolicy)`；
组合根 A2A 传输（`makeA2aTransport`）也收敛到同一入口。

**新门禁不变量 I6（内建数据即随包发布）**：`audit:config-wiring` 由六条不变量扩到七条——
`builtinDefaults.json('<name>')` 的每个数据名必须有 `defaults/<name>.json`，且 `package.json#files`
必须含 `defaults`；带故障注入 selftest 用例（护栏自身不是假绿）。这一条正是缺陷 1 的机械防线。

**回归测试**：`providerAccess.test.ts` 新增「注入策略 ⇒ 发请求前即被 SSRF 拦 / 默认档不拦同一主机」；
`ssrfPolicy.test.ts` 新增「`ssrfOptionsFor` 不丢默认档」；`configWiring.test.ts` 随门禁覆盖 I6。

**验证**：`npm test` **2087 例 / 2082 过 / 1 失败（本机 Chrome e2e，环境问题，与基线同一例）/ 4 skip**；
`check --strict`（569 文件零违规）、`arch:gate`、`api:check`、`audit:config-wiring`（569 文件、七条不变量
＋ selftest）、`audit:maturity`、`checkNodeEngine`、`lint`（0 告警）、`format:check`、`typecheck`（含 web）全绿。

**清理**：删除两个一次性 codemod 临时脚本 `scripts/tmpPolicyTableCodemod.mjs` /
`scripts/tmpToolNameCodemod.mjs`（脚本自述「跑完即删，不入库」），避免它们入库变成新的死资产。

**留档（刻意未改）**：`util/builtinDefaults.ts` 的包根反推写死 `'../../..'`——对 `dist/`（测试与发布布局）
正确，源码布局直跑会指向仓库**父目录**。**不做向上搜索**：那会在「某一层意外存在 `defaults/`」时静默读到
别的数据，属 fail-open，与本模块 fail-closed 的口径冲突；现口径为「要么读到正确目录、要么响亮抛错」，
且仓库内所有入口（`npm test` / `coverage` / evals / bench）都是先 build 再跑。
