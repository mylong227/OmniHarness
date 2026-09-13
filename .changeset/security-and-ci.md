---
'omniharness': minor
---

安全左移与网络防护：CI 新增 `security` job（依赖审计 npm audit + 密钥扫描 gitleaks + 依赖准入检查）；新增 SSRF 防护 `src/security/ssrfGuard.ts`，默认拦截云元数据端点（169.254.169.254 等），对 A2A HTTP 传输与 provider 探针做 fail-closed 校验。
