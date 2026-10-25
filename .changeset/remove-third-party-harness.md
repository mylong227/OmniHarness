---
'@mylong227/omniharness': minor
---

移除全仓第三方 harness 痕迹，并以自研/通用能力回补：

- 删除第三方 Windows ACL 沙箱可选依赖、`WindowsAclSandbox` 与
  `windows-acl` / `windows-acl-readonly` 两个沙箱 profile；未知 profile 仍 fail-closed。
- 删除产品专属外部 worker 及其 CLI 旗标，新增通用 `--worker-external NAME=COMMAND`
  （任务作为独立 argv 追加；Windows 走 npm 垫片安全解析；重名/非法命令 fail-closed）。
- 删除产品专属 hooks 映射，以 `GenericHooksMapper` 保留通用 hooks 映射；
  `HooksCompatAdapter` 仍输出通用 + claude-code 两种信封。
- 删除 `docs/archive/` 并在 CHANGELOG / PROJECT_BOARD / ADR / reports 中清掉相关引用。
- 设置页沙箱下拉补齐 `wsl-bwrap` / `container` 等现行档，并明确
  `policy` / `restricted` 是策略级而非 OS 隔离。
