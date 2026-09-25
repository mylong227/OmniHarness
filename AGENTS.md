# OmniHarness —— 代理/会话须知

本文件由仓库的 projectInstructions 加载器自动读取并注入上下文（`AGENTS.md` 优先于 `CLAUDE.md`）。
只写「不写就会重复踩坑」的事，不复制进度（进度以 `docs/TASK_BOARD.md` 为准）。

## 推送目标：只有一个，且已固定

**唯一归属仓库：`mylong227/OmniHarness`**（远端名 `origin`，已设为 `remote.pushDefault`，`main` 跟踪 `origin/main`）。

- **不要**尝试推送到 `omniharness/omniharness`：那是一个**误建**的组织仓库，本账号对其只有只读权限，
  也无法删除它。历史上曾误以为它是「上游」，为此反复申请写权限、改推送地址、排查镜像与代理，白费多轮。
- `scripts/git-hooks/pre-push`（经 `core.hooksPath` 激活）会**硬拦**推往该误建仓库的尝试；
  推往其它非本账号仓库默认只告警。确需临时放行：`OMNI_ALLOW_FOREIGN_PUSH=1 git push ...`；
  要连非本账号目标一起硬拦：`OMNI_STRICT_PUSH=1`。
- **提交前自检**：`git remote -v` 应只看到 `origin → mylong227/OmniHarness`。看不到别的远程属正常（已清理）。

## 本机网络与凭据（实测，别再重复探测）

| 事实                                                                                       | 影响 / 对策                                                                                               |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `github.com:443` **间歇可通**（实测 1/3 成功），`api.github.com` **稳定可通**              | 直连推送不可靠；**推送走 ghproxy 镜像地址**（已写进 `origin` 的 pushurl，无需改动）                       |
| 本机**没有任何代理/VPN**（无代理进程、无本地代理端口、系统代理关闭）                       | 不要花时间「找代理」「通过镜像打开登录页」——镜像只放行公开缓存页，`/settings/access` 与 `/login` 实测 404 |
| 浏览器（Chrome）可打开 github.com；**CLI 与浏览器通路不同**                                | 需要在网页上操作时用浏览器；需要推代码时用镜像地址                                                        |
| git 凭据 = 已存于 Windows 凭据管理器的 `mylong227` OAuth token（`gho_`，scopes 含 `repo`） | 不存在「token 范围不够」问题；请勿引导用户重配 token                                                      |

## 权限事实（避免误判）

- `mylong227` 对 `OmniHarness/OmniHarness`：`pull=true`，`push/maintain/admin=false`，且**不是**该组织成员。
- 因此：**无法自行授权**，`.../settings/access` 必然 403/404；在**自己的**仓库里加自己会被拒
  （`Repository owner cannot be a collaborator`）。别再让用户去点这些页面。

## 提交与门禁

- 提交走 `scripts/git-hooks/pre-commit`（铁律自检 / 编码标准增量 / ESLint / Prettier / 架构 / 接线 / 文档死链）。
- 钩子在**远端连接之后、传输之前**执行 `pre-push`：对不可达的远端（如 403 的误建仓）会先连接失败，
  因此「钩子没打印拦截文案」不等于钩子失效——用本地 bare 仓库才能端到端验证。
