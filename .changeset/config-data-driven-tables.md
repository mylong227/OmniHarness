---
'omniharness': minor
---

**硬编码策略表全部移出代码**（用户指定：不要在代码里硬编码，方便以后维护）：默认数据改为随包发布的 `defaults/*.json`，用户侧由 `omniharness.json` 覆盖。

**动机**：上一轮已把 SSRF 三表变成**配置字段**，但三张表的**默认值**仍写在 `src/security/ssrfPolicy.ts` 与
`src/util/ipAddress.ts` 里；厂商目录更是硬编码在 `server/services/providerPresets.ts`，而 CLI 又独立维护了一份
`ADAPTER_PRESETS` 手工副本（注释自称「与 providerPresets.ts 同源同步」）——加一家厂商要改两处，两处一旦漂移就会出现
「UI 有这家厂商、CLI 解析不到」的隐性缺口。这类表都是**随环境/厂商变化的数据**，不该是逻辑。

**改动**：

- 新增数据文件：`defaults/ssrf.json`（元数据主机 / 内网后缀 / IPv4 网段）与 `defaults/providers.json`
  （厂商端点 / 默认模型 / 兜底模型清单 / 推理档位 / **`cliAdapters`** / 维护说明 `notes`）；`package.json#files`
  加入 `defaults`，随 npm 包发布。
- 新增 `src/util/builtinDefaults.ts`（`BuiltinDefaults`）：按**模块相对路径**反推包根读取 `defaults/*.json`，
  带缓存；文件缺失 / 不可读 / 非合法 JSON **一律抛错**（fail-closed——安全默认档读不到时静默退化成空表，
  等于护栏「看着还在、实际更松」）。
- 新增 `src/config/providerPresets.ts`（`ProviderPresets`）：厂商目录的**单一来源**。合并语义为
  「`id` 相同**整条替换**、新 `id` **追加**」，不做字段级隐式继承；非法条目（缺字段 / `adapter` 越界 /
  未知 key / 重复 id）一律抛错。
- `FileConfig.providerPresets` 新配置段 + `src/config/providerPresetValidator.ts` 接入 `configError` 校验链
  （与运行时求解器**同源**）；消费方为 CLI 凭据兜底、`ModelCatalogService`（catalog/probe/resolveOverride）、
  `AppServer.warmActiveProvider`、`serverConfigStore` 的厂商启用校验。
- 删除 CLI 的 `ADAPTER_PRESETS` 副本：CLI 专属映射（`responses` → openai、`llamacpp` → ollama）改由预设自带的
  `cliAdapters` **数据**表达，派生逻辑只有 `ProviderPresets.forAdapter` 一份。
- `src/util/ipAddress.ts` 不再内置网段表：`isPrivateIpv4` / `isPrivateIpv6` 的网段表改为**必传参数**
  （`PRIVATE_IPV4_CIDRS` 已删除）。

**顺带修掉两个真实缺陷**：

1. **「声明未接线」**：`configDefaults()` 从不映射 `file.ssrfPolicy`，于是 `args.ssrfPolicy` 恒为 `undefined`——
   写在 `omniharness.json` 里的 `ssrfPolicy` **从未生效**（只有编程 API 路径生效）。接线完整性门禁 I5a 只对
   `src/cli` 做字符串匹配（`args.ssrfPolicy` 足以命中），所以这条断链一直是绿的。已补齐映射并加回归测试。
2. **IPv6 内嵌 IPv4 绕过配置网段**：`isPrivateIpv6` 内嵌 IPv4 的判定走的是函数默认参数（内置表），
   配置过的 `ipv4Blocks` 只对纯 IPv4 生效 ⇒ `[::ffff:10.0.0.1]` 这类等价写法仍按出厂网段判定（双口径）。
   两个守卫（`SsrfGuard` / `NetworkEgressGuard`）现统一传入策略表，口径合一。

**兼容性**：默认行为**逐字不变**（默认档数据与历史硬编码值逐项一致，有测试钉住）；`defaults/` 未随包发布时
会在启动期显式报错而不是静默放宽。`PRIVATE_IPV4_CIDRS` 与 `isPrivateIpv4` / `isPrivateIpv6` 的签名属包内模块
（`package.json#exports` 只暴露 `.` 与 `./beta`，无深层导入契约）。

**验证**：`npm test` 2079 例 / 2074 过 / 1 失败（本机 Chrome 环境用例，与基线一致）/ 4 skip——新增 18 例
（`tests/unit/providerPresets.test.ts` 7 例 + `tests/unit/ssrfPolicy.test.ts` 新增 5 例，其余为既有用例扩展）；
`typecheck`（含 web）/ `lint` / `format:check` / `check --strict`（567 文件零违规）/ `arch:gate --strict` /
`audit:config-wiring`（567 文件六条不变量全绿）全通过。
