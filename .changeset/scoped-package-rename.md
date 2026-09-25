---
'@mylong227/omniharness': minor
---

包名改为 scoped：`omniharness` → `@mylong227/omniharness`

npm 公共源上的 `omniharness` 裸名已被第三方占用（tim_carter_clausen，0.0.1），无法发布。
scoped 名绑定发布者账号（免费、可公开访问：`npm i @mylong227/omniharness`）。
同步新增 `publishConfig.access: public`（scoped 首发必须显式公开）。
