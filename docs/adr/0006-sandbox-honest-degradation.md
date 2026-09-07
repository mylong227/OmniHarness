# 0006 沙箱多后端与诚实降级（不支持即 fail-closed）

- 日期：2026-09-06
- 状态：已接受

## 背景

不同 OS 提供不同的强隔离手段（Linux: landlock / seccomp / bwrap；macOS: seatbelt；Windows: 受限令牌）。
并非所有后端在任意环境都可用。若「不支持」被静默降级为「全放行」，会产生虚假的安全感——这是比
「明确不支持」更危险的状态。

## 决策

- `SandboxManager` 按 profile 选后端：`policy` / `restricted` 为真实策略后端（默认 `policy`）；
  `landlock` / `seatbelt` / `bwrap` 为 OS 级强隔离后端；
- **不支持的 OS 后端一律占位 + fail-closed**（声明「本环境不可用」，绝不谎称已隔离）；
- 默认沙箱从 `passthrough`（全放行）翻转为 `policy`（开箱即拦截危险命令 + 工作区外路径），fail-closed 收紧。

## 后果

- 正面：安全默认正确；「不支持」显式可见，不会被误判为已隔离。
- 负面：强隔离能力受运行环境影响，跨平台一致性有限。
- 替代方案：不支持时退回全放行（曾存在，因安全缺口已否决）。
