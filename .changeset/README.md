# Changesets

本仓库用 [Changesets](https://github.com/changesets/changesets) 管理版本与发版。

## 工作流

1. 改动合并前，运行 `npm run changeset` 添加一个变更说明（选 `patch` / `minor` / `major`）。
   生成 `.changeset/*.md` 片段，随 PR 一起提交。
2. 合并到 `main` 后，`Release` 工作流（`release.yml`）自动开一个
   **“Version Packages”** PR，把累积的 changeset 合成为 `CHANGELOG.md` 更新 + 版本号 bump。
3. 合并该 PR → 工作流执行 `changeset publish` 把包发到 npm。

## 发版前置（一次性外部设施）

- 在仓库 Secrets 配置 `NPM_TOKEN`（npm 账号的 Automation/Publish 令牌）。
- `release.yml` 已用 `registry-url: https://registry.npmjs.org` + `NPM_TOKEN` 接入，无需改代码。
- 未配置 `NPM_TOKEN` 前，工作流会创建 Version Packages PR 但不发布（不静默失败，PR 步骤报错可见）。

## 注意

- 仅 `devDependencies` 引入 `@changesets/cli`，**不影响运行时零依赖铁律**。
- `access: "public"` 与 `package.json` 的 `publishConfig.access` 一致。
