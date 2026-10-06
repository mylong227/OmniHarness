# OmniHarness —— 代理/会话须知

本文件由仓库的 projectInstructions 加载器自动读取并注入上下文（`AGENTS.md` 优先于 `CLAUDE.md`）。
只写「不写就会重复踩坑」的事，不复制进度（进度以 `docs/PROJECT_BOARD.md` 为准）。

## 推送目标：只有一个，且已固定

**唯一归属仓库：`mylong227/OmniHarness`**（远端名 `origin`，已设为 `remote.pushDefault`，`main` 跟踪 `origin/main`）。

- **不要**尝试推送到 `omniharness/omniharness`：那是一个**误建**的组织仓库，本账号对其只有只读权限，
  也无法删除它。历史上曾误以为它是「上游」，为此反复申请写权限、改推送地址、排查镜像与代理，白费多轮。
- `scripts/git-hooks/pre-push`（经 `core.hooksPath` 激活）会**硬拦**推往该误建仓库的尝试；
  推往其它非本账号仓库默认只告警。确需临时放行：`OMNI_ALLOW_FOREIGN_PUSH=1 git push ...`；
  要连非本账号目标一起硬拦：`OMNI_STRICT_PUSH=1`。
- **镜像 TLS 故障时的推送旁路（2026-10-06 实测有效）**：ghproxy 偶发证书错误
  （`SEC_E_CERT_EXPIRED` / `SEC_E_WRONG_PRINCIPAL`，隔几分钟可能自愈）。镜像证书是
  「隔几分钟可能自愈」级别的故障，故只旁路不改配置——直连 github.com 历史 1/3 成功率，
  重试即可。**不能**用 `git -c url...insteadOf` 旁路：remote.origin.pushurl 本身就是镜像 URL
  （不参与重写），且 pushInsteadOf 优先于 insteadOf。有效写法是**最长前缀身份重写 + 显式 URL**：
  `git -c url."https://github.com/mylong227".pushInsteadOf=https://github.com/mylong227 push https://github.com/mylong227/OmniHarness.git main`
- **提交前自检**：`git remote -v` 应只看到 `origin → mylong227/OmniHarness`。看不到别的远程属正常（已清理）。

## 本机网络与凭据（实测，别再重复探测）

| 事实                                                                                       | 影响 / 对策                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github.com:443` **间歇可通**（实测 1/3 成功），`api.github.com` **稳定可通**              | 直连不可靠。**已两层兜住**：① 本仓 `origin` 的 pushurl 固定为 ghproxy 镜像；② **全局 `~/.gitconfig` 已改为推送也走镜像**（`url."https://ghproxy.net/https://github.com/".pushInsteadOf`；原来那条把推送改回直连的 no-op 规则已删除）⇒ 本机所有仓库 fetch/push 均经镜像。回滚：`git config --global --unset url."https://ghproxy.net/https://github.com/".pushInsteadOf`，再加回 `url."https://github.com/".pushInsteadOf=https://github.com/` |
| 本机**没有任何代理/VPN**（无代理进程、无本地代理端口、系统代理关闭）                       | 不要花时间「找代理」「通过镜像打开登录页」——镜像只放行公开缓存页，`/settings/access` 与 `/login` 实测 404                                                                                                                                                                                                                                                                                                                                     |
| 浏览器（Chrome）可打开 github.com；**CLI 与浏览器通路不同**                                | 需要在网页上操作时用浏览器；需要推代码时用镜像地址                                                                                                                                                                                                                                                                                                                                                                                            |
| git 凭据 = 已存于 Windows 凭据管理器的 `mylong227` OAuth token（`gho_`，scopes 含 `repo`） | 不存在「token 范围不够」问题；请勿引导用户重配 token                                                                                                                                                                                                                                                                                                                                                                                          |

## 权限事实（避免误判）

- `mylong227` 对 `OmniHarness/OmniHarness`：`pull=true`，`push/maintain/admin=false`，且**不是**该组织成员。
- 因此：**无法自行授权**，`.../settings/access` 必然 403/404；在**自己的**仓库里加自己会被拒
  （`Repository owner cannot be a collaborator`）。别再让用户去点这些页面。

## 提交与门禁

- 门禁清单**只认唯一实现 `scripts/runGates.mjs`**（`fast` 层 10 项 + `typed` 层 2 项），本文件**不再复述**——
  这里曾抄过一份清单，抄的时候就漂了（写着已不在清单里的 Prettier）。
  `pre-commit` 只是它的薄包装（`exec node scripts/runGates.mjs --hook`）；类型层（`tsc --noEmit` + 类型感知 ESLint）另跑 `npm run gate:typed`。
  要加/改门禁只改那一份文件与其 `GATES` 数组，别再往文档里抄第二份清单。
- 钩子在**远端连接之后、传输之前**执行 `pre-push`：对不可达的远端（如 403 的误建仓）会先连接失败，
  因此「钩子没打印拦截文案」不等于钩子失效——用本地 bare 仓库才能端到端验证。

## 一键启动与前端构建形态

- `npm start`（`scripts/startAll.mjs`）= **构建服务端 + 构建前端 + 起 HTTP UI**，一步到位；
  参数透传：`npm start -- --port 9000`。
- `npm run dev`（`scripts/devAll.mjs`）= 构建一次后 serve + 前端 `tsc --watch`（改前端不必重启 serve）。
- 前端**没有打包器、也没有 dev server**：`web/index.html` 用原生 ES Module 直接加载 `web/dist/main.js`
  （由 `npm run web:build` 产出，URL 带时间戳防旧缓存）。
  ⇒ **只 `npm run build` 而漏 `npm run web:build`，页面必定白屏**——不是「样式没生效」，是入口文件根本不存在；
  排查白屏第一步：看 `web/dist/main.js` 在不在。

## 本机配置与工作区解析

- **工作区根解析链**：`--workspace` > **本机固定项目**（用户级 `~/.omniharness/omniharness.json` 的 `workspace`）
  > 启动目录；命中哪一级由 serve 横幅打印（实现 `src/cli/serveWorkspace.ts`）——「换个目录启动就看到别的项目」通常不是 bug。
- **配置分层链**：内置默认 → 用户级 → 项目级 `omniharness.json` → `--profile` → bundle 补丁 → 环境变量 → CLI。
- `workspace` / `workspaces` **只写用户级**（项目级文件里不该出现）；家目录下的路径写回时压成 `~/…`。
- 配置文件解析**容忍 UTF-8 BOM**（`src/config/configFile.ts`）——别把「配置没生效」先归因到 BOM。
- **会话存档在 `~/.omniharness/sessions/`（全局）**，归属按 `session_meta.payload.workspace` 标记：
  `sessions.list` 缺省只回当前项目，`workspace:'*'` 才回全部——「别的项目的会话去哪了」先查这条。
- serve **默认只绑 `127.0.0.1`**：示例 URL 写 `http://127.0.0.1:8787`，别写 `localhost`（解析到 `::1` 时连不上）。

## CLI 旗标必须登记（否则被静默打死）

- **新增任何 CLI 旗标都要登记进 `src/cli/knownFlags.ts`**。真实教训：`--auto-approve` 是 serve 的真旗标
  （`cliServerCmds.ts` 用 `args.includes('--auto-approve')` 读），却**从未登记**，于是被「未知旗标 fail-closed」打死——
  `serve --auto-approve` 直接报未知旗标退出，而 `--help` 与文档都还写着它（2026-10-06 修）。
  同一轮还揪出 `--version` / `--compliance` / `--allow-all`。
- 判据在 `tests/unit/knownFlags.test.ts`：扫描面已从「reader 式读取」扩到 `Array.includes(`，并附一条**实跑正对照**；
  改了旗标解析就重跑它——只登记不实跑仍可能漏。
