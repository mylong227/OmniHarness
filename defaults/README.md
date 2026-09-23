# `defaults/` —— 随包发布的内建默认数据

这里的 JSON 是**数据**，不是代码。它们此前写死在 `.ts` 实现里，改一条网段、加一家模型厂商、
换一个端点地址都要改代码重新发布，或在多个文件间手工同步（CLI 的 `ADAPTER_PRESETS` 就曾是
`providerPresets.ts` 的手工副本；`https://api.openai.com/v1` 曾在 `cliBuildConfig` 与 `configBuilder`
里各写一遍）。现在改数据即可，用户特有的差异走 `omniharness.json` 或环境变量覆盖。

## 文件与消费方

| 文件             | 内容                                                | 单一来源实现                                          | 覆盖入口                                                         |
| ---------------- | --------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------- |
| `ssrf.json`      | 云元数据主机 / 内网域名后缀 / IPv4 私有保留网段     | `src/security/ssrfPolicy.ts`（`DEFAULT_SSRF_POLICY`） | `omniharness.json` 的 `ssrfPolicy`                               |
| `providers.json` | 大模型厂商目录（端点 / 模型 / 推理档位 / CLI 映射） | `src/config/providerPresets.ts`（`ProviderPresets`）  | `omniharness.json` 的 `providerPresets`                          |
| `endpoints.json` | 适配器兜底端点/模型/凭据 env 名 + 各服务端点地址    | `src/util/endpointDefaults.ts`（`EndpointDefaults`）  | CLI/配置文件显式值 > 该适配器的 env > 本文件（服务端点见 `env`） |

三个文件都由 `src/util/builtinDefaults.ts` 按**模块相对路径**读包根下的 `defaults/`（不做 cwd 推断），
结果缓存。**文件缺失 / 不可读 / 不是合法 JSON 一律抛错**（fail-closed）：安全默认档读不到时静默退化成空表，
等于护栏「看着还在、实际更松」。

> 发布要求：`package.json#files` 必须含 `defaults`，否则安装后启动即报错（这是刻意的响亮失败，不是静默放宽）。

## `ssrf.json`

三个字段**都必须存在且为数组**（缺任一段会被 `security/ssrfPolicy.ts` 当场拒绝）：

| 字段               | 含义                                     | 匹配方式                                      |
| ------------------ | ---------------------------------------- | --------------------------------------------- |
| `metadataHosts`    | 云元数据端点主机名 / IP                  | 精确匹配（`allowMetadata` 无法覆盖，恒拦）    |
| `internalSuffixes` | 内网 / 本机域名后缀，**必须以 `.` 开头** | `endsWith` 匹配（`localhost` 另有显式判定）   |
| `ipv4Blocks`       | `[基点, 前缀长度]` 形式的私有 / 保留网段 | CIDR 包含判定；同时作用于 IPv6 内嵌 IPv4 写法 |

`ipv4Blocks` 各项的由来（改动前请先想清楚「拦更多还是放更多」）：

| 网段          | 前缀 | 用途                                       |
| ------------- | ---- | ------------------------------------------ |
| `0.0.0.0`     | 8    | 本网络                                     |
| `10.0.0.0`    | 8    | 私有                                       |
| `100.64.0.0`  | 10   | CGNAT（运营商级 NAT）                      |
| `127.0.0.0`   | 8    | 环回                                       |
| `169.254.0.0` | 16   | 链路本地（**含云元数据 169.254.169.254**） |
| `172.16.0.0`  | 12   | 私有                                       |
| `192.0.0.0`   | 24   | IETF 协议分配                              |
| `192.168.0.0` | 16   | 私有                                       |
| `198.18.0.0`  | 15   | 基准测试                                   |
| `224.0.0.0`   | 4    | 组播                                       |
| `240.0.0.0`   | 4    | 保留（含 `255.255.255.255`）               |

**变更纪律**：这里的任何改动都会改变**所有未配置用户**的拦截面，须在看板登记并写明理由。
只想对自己环境生效，请写 `omniharness.json`：

```json
{ "ssrfPolicy": { "internalSuffixes": [".localhost", ".corp", ".mycompany"] } }
```

语义是**替换**（不是合并）：写了哪一项就整体替换哪一项，**显式给空数组**表示清空该项（显式且危险，不静默）。
非法条目（坏 CIDR、越界前缀、不以 `.` 开头的后缀、含空白的主机）一律抛错。

## `providers.json`

```json
{
  "presets": [
    {
      "id": "deepseek",
      "label": "DeepSeek",
      "adapter": "openai",
      "cliAdapters": ["openai"],
      "baseUrl": "https://api.deepseek.com",
      "defaultModel": "deepseek-v4-flash",
      "needsKey": true,
      "models": ["deepseek-v4-flash"],
      "reasoningEffort": ["none", "low", "medium", "high"],
      "notes": "来源 / 实测日期 / 为何这么配（纯文档字段）"
    }
  ]
}
```

| 字段              | 必填 | 说明                                                               |
| ----------------- | ---- | ------------------------------------------------------------------ |
| `id`              | 是   | 厂商标识，`providerKeys` 的键；**唯一**，不含空白                  |
| `label`           | 是   | UI 展示名（允许空格，如 `Moonshot Kimi`）                          |
| `adapter`         | 是   | `openai` / `anthropic` / `responses`——模型构造用哪个适配器         |
| `cliAdapters`     | 否   | 哪些 `--model-adapter` 取值应解析到本厂商，**缺省 `[adapter]`**    |
| `baseUrl`         | 是   | `http(s)://` 端点                                                  |
| `defaultModel`    | 是   | 启用该厂商时的默认模型                                             |
| `needsKey`        | 是   | 是否必需 Key（本地 Ollama 为 `false`）                             |
| `models`          | 是   | `/v1/models` 不可用时的兜底清单（可为空数组）                      |
| `reasoningEffort` | 否   | 该厂商合法的 `reasoning_effort` 档位；空/缺省 = 不暴露推理强度下拉 |
| `notes`           | 否   | 维护说明（来源、实测日期、遗留问题）；不参与任何判定               |

**加一家厂商只需改本文件**：追加一条记录即可，CLI（`--model-adapter` 反查、`providerKeys` 凭据兜底）、
服务端（厂商卡片 / Key 探测 / 运行时模型构造）与 UI 都从这一份派生。若它的 CLI 归属与 `adapter` 不同
（如 Ollama 的 `adapter` 是 `openai`、但 CLI 侧属 `llamacpp`），**显式写 `cliAdapters`**——不要另开映射表，
那正是此前两处漂移的根因。

用户可覆盖或追加（按 `id` **整条替换**，新 `id` **追加**；不做字段级继承，缺字段会被拒绝）：

```json
{
  "providerPresets": [
    {
      "id": "corp-gateway",
      "label": "公司自建网关",
      "adapter": "openai",
      "baseUrl": "https://llm-gateway.corp/v1",
      "defaultModel": "internal-1",
      "needsKey": true,
      "models": ["internal-1"]
    }
  ]
}
```

## `endpoints.json`

**适配器兜底**（`modelAdapters`）与**服务端点**（`services`）两段。前者是「连厂商都没选」时的最后一道默认，
后者是各功能模块自己要用的地址。

```json
{
  "modelAdapters": [
    {
      "id": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "model": "gpt-4o-mini",
      "requiresApiKey": true,
      "apiKeyEnv": "OPENAI_API_KEY",
      "baseUrlEnv": "OPENAI_BASE_URL",
      "modelEnv": "OPENAI_MODEL",
      "notes": "改动理由 / 与哪个预设不可合并"
    }
  ],
  "services": [
    {
      "id": "pluginRegistryIndex",
      "url": "https://registry.omniharness.dev/index.json",
      "env": "OMNI_REGISTRY_URL",
      "notes": "…"
    }
  ]
}
```

| `modelAdapters` 字段 | 必填 | 说明                                                                              |
| -------------------- | ---- | --------------------------------------------------------------------------------- |
| `id`                 | 是   | 适配器标识（`--model-adapter` 取值：`openai`/`anthropic`/`responses`/`llamacpp`） |
| `baseUrl`            | 是   | 兜底端点（http(s)）                                                               |
| `model`              | 是   | 兜底模型名                                                                        |
| `requiresApiKey`     | 是   | 是否必须给 Key（本地 Ollama 为 `false`）                                          |
| `apiKeyEnv`          | 否   | Key 的环境变量名（**同时用于拼错误提示**，改名后提示自动跟随）                    |
| `baseUrlEnv`         | 否   | 端点的环境变量名                                                                  |
| `modelEnv`           | 否   | 模型名的环境变量名                                                                |
| `notes`              | 否   | 维护说明（为什么是这个值、与哪个预设不可合并）                                    |

生效优先级（`cliBuildConfig.buildModel` 与 `configBuilder.buildRouterAdapter` 同一口径）：
**CLI / 配置文件显式值 > `xxxEnv` 环境变量 > 本文件的 `baseUrl` / `model`**。

| `services` 字段 | 必填 | 说明                                                                   |
| --------------- | ---- | ---------------------------------------------------------------------- |
| `id`            | 是   | 服务标识（调用方按字面量取用；**拼错即抛错**，不会静默拿到 undefined） |
| `url`           | 是   | 地址；支持 `{port}` 模板（由调用方代入）                               |
| `env`           | 否   | 可覆盖该地址的环境变量名                                               |
| `notes`         | 否   | 维护说明                                                               |

现有服务端点：`pluginRegistryIndex`（插件市场索引，env `OMNI_REGISTRY_URL`）、
`gitRemoteBase`（SWE-bench 克隆远端基址）、`githubApiBase`（GitHub Contents API，env `GITHUB_API_URL`，
沿用 GitHub Actions 标准名，故 GHE 环境天然生效）、`cdpProbeUrl` / `cdpVersionPath`（浏览器 CDP 自检）。

**别把 `endpoints.json` 与 `providers.json` 合并**：厂商预设按**厂商**组织、可被用户整体覆盖；
适配器兜底按**适配器**组织、是「没选厂商」时的兜底。合并会让「用户覆盖某厂商」意外改掉适配器兜底。
最典型的例子是 Ollama：`endpoints.json` 的 `llamacpp` 兜底是 `http://localhost:11434`（原生 `/api/chat`），
而 `providers.json` 的 `ollama` 预设是 `http://localhost:11434/v1`（OpenAI 兼容层）——**两者都对，勿统一**。

## 改完怎么验

```bash
npm run typecheck && npm test          # 钉住「默认值与历史逐字一致」「CLI 映射等价」「地址不再出现在 src」
node scripts/auditConfigWiring.mjs     # 配置字段的「声明→装配→运行时→消费」四段接线
node scripts/check.mjs --strict        # 文件/函数体量等铁律
```

`tests/unit/endpointDefaults.test.ts` 里有一条**反硬编码守卫**：它会扫描 `src/**` 的代码行（注释除外），
若 `api.openai.com` / `api.anthropic.com` / `localhost:11434` / `registry.omniharness.dev` / `api.github.com`
/ `github.com/` / `/json/version` 再次出现在实现里（而不是本目录的数据文件），测试直接失败。
