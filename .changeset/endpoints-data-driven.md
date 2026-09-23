---
'omniharness': minor
---

**端点/地址硬编码移出代码**（用户指定：地址类硬编码也要专门的配置文件管理）：新增 `defaults/endpoints.json`，`buildModel` 与 `buildRouterAdapter` 不再各写一份端点字面量。

**动机**：`cliBuildConfig.buildModel` 里硬编码了 `https://api.openai.com/v1` / `https://api.anthropic.com` /
`http://localhost:11434` 与兜底模型名、凭据环境变量名，而 `configBuilder.buildRouterAdapter` **又写了一遍同样的三个端点**——
典型的「改一处漏一处」。插件市场索引、SWE-bench 的 GitHub 基址、浏览器 CDP 自检地址也各自硬编码，
企业换私有 registry / GitHub Enterprise / 自建网关必须改代码重发。

**改动**：

- 新增数据文件 `defaults/endpoints.json`：`modelAdapters`（适配器 → 兜底 `baseUrl` / `model` /
  `requiresApiKey` / `apiKeyEnv` / `baseUrlEnv` / `modelEnv` / 维护说明）+ `services`（服务标识 → 地址 +
  可选 env 覆盖 + 说明）。
- 新增 `src/util/endpointDefaults.ts`（`EndpointDefaults`）：解析 + 严格校验（未知 key / 缺字段 / 类型错 /
  id 重复一律抛错），提供 `resolveAdapter(id, env)` 与 `urlOf(id, env)`；**未知服务标识也抛错**，
  不静默返回 undefined（否则会拼出 `undefined/repos/...` 这种请求）。放在公共层 `util/` 是为了避免
  `adapters/`、`plugin/`、`eval/` 反向依赖装配层（见 `ARCHITECTURE_SPEC.md` §2.1 目录归属表）。
- 消费点改造（值全部来自数据，优先级不变）：
  `cliBuildConfig.buildModel`（4 个适配器分支）、`configBuilder.buildRouterAdapter`（**消除与前者重复的端点**）、
  `plugin/registrySourcesShared.DEFAULT_REGISTRY_URL`（env `OMNI_REGISTRY_URL` 仍优先）、
  `eval/nativeExecutor` 的 `repoBaseUrl` 兜底（显式 `repoBaseUrl` 仍优先）、
  `benchmark/terminalbench/taskFetcher` 的 GitHub API 基址（新增标准名 `GITHUB_API_URL` 覆盖，
  GitHub Enterprise 天然生效）、`adapters/browser/cdpClient` 与 `browserAvailability` 的 CDP 自检地址/路径。
- 错误提示文案也改为拼数据值：改了 `apiKeyEnv` 或 `cdpVersionPath` 之后，提示不会再说谎。

**兼容性**：所有兜底值与历史**逐字一致**（有测试逐条钉住）；错误提示文案除环境变量名/路径改为动态拼接外，
文本不变；新增的唯一新旋钮是 `GITHUB_API_URL`（未设置时行为完全不变，GitHub Actions 里其值本就等于
`https://api.github.com`）。

**验证**：新增 `tests/unit/endpointDefaults.test.ts` 6 例（兜底值与历史逐字一致 / env 覆盖与空白语义 /
未知标识抛错 / 非法数据 fail-closed / **反硬编码守卫**（扫描 `src/**` 代码行，地址字面量只允许存在于
`defaults/`，注释除外）/ 消费点走数据）；`npm test` 2085 例 / 2080 过 / 1 失败（本机 Chrome 环境用例，
与基线同一条）/ 4 skip；`typecheck`（含 web）/ `lint` / `format:check` / `check --strict`（568 文件零违规）/
`arch:gate --strict` / `audit:config-wiring`（568 文件六条不变量全绿）全通过。
