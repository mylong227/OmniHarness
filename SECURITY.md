# 安全策略（Security Policy）

## 报告漏洞

**请勿在公开 issue 中披露安全漏洞。** 请使用 GitHub 的「私下报告漏洞」通道：
仓库页 **Security → Advisories → Report a vulnerability**（私有，仅维护者可见），
或在 issue 中申请私下沟通后再附细节。

- 反馈内容请包含：影响面（哪个入口 / 哪类数据）、复现步骤或最小复现、
  你评估的严重级别。
- 本项目当前没有专职安全邮箱；GitHub Security Advisory 是唯一收敛通道。

## 响应承诺（尽力而为，如实声明）

- 本项目为个人维护的开源项目，**无 SLA**；目标是在 7 天内给出初步回应，
  修复时间视复杂度而定，修复后会在 CHANGELOG 与 Security Advisory 中留痕。
- 若漏洞涉及已发布的 npm 包，修复版本会经 changesets 正常发版并在
  Release 说明中标注安全性质。

## 支持的版本

| 版本           | 支持状态                                         |
| -------------- | ------------------------------------------------ |
| main           | 只修最新（本地优先的单分支项目，无长期支持分支） |
| npm 已发布版本 | 随最新版一起修（未发布历史版本不单独出补丁）     |

## 仓库自身的安全机制（盘点入口）

- **零密钥门禁**：`scripts/checkSecrets.mjs`（pre-commit 强制）+ `.gitleaks.toml`
  - CI 全历史 gitleaks 扫描。历史上发生过一次真实密钥入库事故（2026-09-08），
    已全史重写并轮换，门禁即那次事故的产物——不要绕过它。
- **依赖准入**：`dependency-allowlist.json`（许可证白名单 + 分层铁律：
  `src/contracts/ports/**`、`src/kernel/core/**` 恒第三方依赖自由）+ CI `npm audit --audit-level=high`。
- **SSRF 防护**：`src/kernel/security/ssrfGuard.ts`（云元数据/私有网段 fail-closed，
  DNS 二次判定默认开启；残余的 DNS rebinding 风险已在 `src/contracts/ports/security/ssrfOptions.ts`
  如实登记）。
- **审批 fail-closed**：审批超时按 deny、未知生效模式抛错、信任写盘失败按未信任处理。
- **架构门禁**：`scripts/runGates.mjs`（fast 10 项 + typed 2 项）在提交与 CI 双侧拦截。

## 范围边界（如实声明）

- 本项目默认**单机单用户**本地部署形态（`serve` 只绑 `127.0.0.1`）；面向公网多租户
  的部署形态不在当前威胁模型内（见 `docs/ARCHITECTURE_SPEC.md`）。
- 模型 API Key 等凭据由用户自备并存放于本机（DPAPI 保护）；本项目不代管云端凭据。
