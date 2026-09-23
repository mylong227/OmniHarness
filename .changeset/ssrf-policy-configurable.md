---
'omniharness': minor
---

SSRF / 出站策略表**配置化**（用户指定）：`METADATA_HOSTS` / `INTERNAL_SUFFIXES` / `IPV4_BLOCKS` 三张硬编码表移入配置。

**动机**：三张表原先写死在 `SsrfGuard` 里——想加一个自建元数据端点、或放行某个内网域，都必须改代码重新发布；
而这类表本身就是**策略数据**（随云厂商清单与企业网络拓扑变化）。现下沉为配置字段 `ssrfPolicy`，
实现里只保留**默认档**（缺失字段回落默认，零配置开箱即用、行为与历史一致）。

**改动（装配→运行时→消费全链）**：

- 新增 `src/security/ssrfPolicy.ts`：`SsrfPolicy` / `SsrfPolicyConfig` / `DEFAULT_SSRF_POLICY` /
  `resolveSsrfPolicy()`（缺省回落默认；非法条目**抛错**而非静默丢弃）。
- 配置声明：`FileConfig.ssrfPolicy` 与 `OmniHarnessConfig.ssrfPolicy`；新增
  `src/config/ssrfPolicyValidator.ts` 并接入 `configError` 校验链（与运行时解析器**同源**，
  杜绝「配置层说合法、运行时抛错」的双口径）。
- 消费方：`SsrfGuard`（元数据主机 / 内网后缀 / IPv4 网段全部取自策略，含 IPv6 内嵌 IPv4 等价写法）、
  `NetworkEgressGuard`（与 SSRF 护栏共用同一份策略与同一 IP 分类器）、CLI 出站守卫
  （`applyNetworkGuard` 用 `resolveSsrfPolicy(args.ssrfPolicy)`）、组合根 A2A 传输
  （`resolveSsrfPolicy(config.ssrfPolicy)`）。配置链路：`omniharness.json` → CLI 层 → 组合根。

**语义（显式，不静默）**：字段缺省 ⇒ 默认表；字段**显式给空数组** ⇒ 该项清空（危险但显式）；
非法条目（坏 CIDR、越界前缀长度、不以 `.` 开头的后缀、含空白的主机）⇒ 抛错。

**行为变更（收紧，已登记）**：`.corp` 原先只存在于出站守卫的私有主机正则里，SSRF 护栏没有它
⇒ 两个守卫对企业内网域名判定不一致。配置化时合一，**默认后缀表并入 `.corp`**，SSRF 护栏现在也拦 `.corp`。

**回归测试**：新增 `tests/unit/ssrfPolicy.test.ts` 7 例（默认档与历史逐字一致 / 自定义表替换语义生效 /
出站守卫同源 / 非法条目抛错 / 显式清空语义 / 校验器与解析器同源）；既有 `ssrfGuard`、`networkEgress`
用例全绿；`audit:config-wiring` 六条不变量全绿（新增字段真的被读、被透传、被消费）。
