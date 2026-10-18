# OmniHarness —— 代理/会话须知

本文件由仓库的 projectInstructions 加载器自动读取并注入上下文（`AGENTS.md` 优先于 `CLAUDE.md`）。
只写「不写就会重复踩坑」的事，不复制进度（进度以 `docs/PROJECT_BOARD.md` 为准）。

## 导入约定（2026-10-17 起，前后端统一）

- **相对导入一律写真实源文件后缀 `.ts`/`.tsx`**，不再写 `.js`。新代码照此写；
  断言「源码 import 形态」的判据/脚本也按 `.ts` 匹配（如需兼容可两种后缀都认）。
- 机制：根 tsconfig 开了 **`rewriteRelativeImportExtensions`**（TS 5.7+）——源码 `.ts` 后缀在
  emit 时自动重写回 `.js`，dist 产物仍是标准 ESM；web tsconfig（noEmit）用 `allowImportingTsExtensions`。
- **别再给 Vite/Vitest 加 `.js → .ts` 回落插件**（`scripts/vitePluginJsToTs.ts` 已删）。
- **有意保留 `.js` 的三类位置**（不要"顺手统一"掉）：注释/文档里的描述、测试夹具里的假文件名、
  指向 dist 编译产物或真实 `.js` 文件的**运行时路径字符串**（如 `dist/src/cli/exec.js`）。
- 断言导入形态的结构判据若仍匹配 `.js` 会**静默退化或假红**——改导入约定时必须同步排查
  `tests/unit/` 里所有对源码做文本断言的判据（本轮实例：`cliStartupBudget` 的变异探针、`crashGuard ⑦`）。

## 推送目标：只有一个，且已固定

**唯一归属仓库：`mylong227/OmniHarness`**（远端名 `origin`，已设为 `remote.pushDefault`，`main` 跟踪 `origin/main`）。

- **不要**尝试推送到 `omniharness/omniharness`：那是一个**误建**的组织仓库，本账号对其只有只读权限，
  也无法删除它。历史上曾误以为它是「上游」，为此反复申请写权限、改推送地址、排查镜像与代理，白费多轮。
- `scripts/git-hooks/pre-push`（经 `core.hooksPath` 激活）会**硬拦**推往该误建仓库的尝试；
  推往其它非本账号仓库默认只告警。确需临时放行：`OMNI_ALLOW_FOREIGN_PUSH=1 git push ...`；
  要连非本账号目标一起硬拦：`OMNI_STRICT_PUSH=1`。
- **推送必须走直连，镜像只用于读**（2026-10-17 实测，纠正了此前本条里的错误说法）：
  - `git push origin main` **必失败**：`origin` 的 fetch/push URL 都是 `ghproxy.net`，而镜像的
    POST **不转发授权头** ⇒ `remote: Invalid username or token. Password authentication is not supported`。
    换成经镜像的 URL 也救不回来。
  - 本机**没有**全局 `pushInsteadOf` 镜像规则（`git config --global --get-regexp 'url\..*insteadOf'`
    为空），所以不必也不要用 `-c url...pushInsteadOf=` 去"绕过"——那样反而把目标改写成
    `https://github.com/mylong227` 这种不被 git 信任的 URL 形式。
    （2026-10-06 曾把这条 `-c` 写法记成"有效旁路"，2026-10-17 复测证伪：它只在极少数情况下碰巧成功，
    失败时分别报 `stale info` 或 `Invalid username or token`。已删除该说法，别再照抄。）
  - **有效写法**（直连 github.com，浏览器能打开即说明通路在）：
    ```bash
    git push https://github.com/mylong227/OmniHarness.git main
    ```
    首次会走**浏览器/设备授权弹窗**，授权一次后本次会话内多次推送都不必再点；直连是间歇性的，
    失败就等几秒重试（实测常 1～3 次内成功）。
  - **改写历史后**必须 `--force-with-lease`，且**lease 值要显式给远端真实哈希**——本机没有
    `refs/remotes/origin/main` 或它已过期时，裸 `--force-with-lease` 会一直报
    `! [rejected] main -> main (stale info)`：
    ```bash
    H=$(git ls-remote https://github.com/mylong227/OmniHarness.git refs/heads/main | cut -f1)
    git push --force-with-lease=main:$H https://github.com/mylong227/OmniHarness.git main
    ```
- **提交前自检**：`git remote -v` 应只看到 `origin → mylong227/OmniHarness`。看不到别的远程属正常（已清理）。

## 本机网络与凭据（实测，别再重复探测）

| 事实                                                                                | 影响 / 对策                                                                                                                                        |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github.com:443` **间歇可通**，`ghproxy.net:443` 稳定可通                           | **读走镜像、写走直连**（见上节）：fetch 用 `origin`（镜像）稳；push 必须直连真实 URL，失败重试即可。**镜像不可用于推送**——它不转发授权头，必然 401 |
| 本机**没有任何代理/VPN**（无代理进程、无本地代理端口、系统代理关闭）                | 不要花时间「找代理」「通过镜像打开登录页」——镜像只放行公开缓存页，`/settings/access` 与 `/login` 实测 404                                          |
| 浏览器（Chrome）可打开 github.com；推送授权也走浏览器                               | 需要网页操作时用浏览器；首次直连推送会弹授权，**用户在网页上点一次即可**，之后同会话内免重复授权                                                   |
| git 凭据 = Windows 凭据管理器的 `mylong227` OAuth token（`gho_`，scopes 含 `repo`） | 不存在「token 范围不够」问题；请勿引导用户重配 token。也**不要**在推送前设 `GIT_TERMINAL_PROMPT=0`——它会掐掉授权弹窗（报 `User cancelled dialog`） |

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
- `npm run dev`（`scripts/devAll.mjs`）= 构建一次后 serve + **Vite dev server**（HMR）。
  改前端**热更新**、不必重启；但**要访问 Vite 的地址**（默认 `http://localhost:5173`，它把
  `/rpc` `/events` `/files` 代理到后端），而不是后端端口。
- 前端是**标准 Vite + React + TypeScript 项目**（2026-10-17 从「零打包器 + tsc 直出 ESM + React UMD 全局」
  迁移而来，**旧的架构描述已作废**，别按旧记忆行事）：
  - 入口 `web/src/main.ts`（也是样式的 import 处），产物 `web/dist/`（`npm run web:build` = `vite build`，
    单 bundle 带 hash）；
  - 依赖全部 npm（react / react-dom / markdown-it / katex / highlight.js），**无 `web/vendor/`、无 UMD `<script>`**；
  - UI 一律 `import * as React from 'react'`，**没有 `deps.ts` 间接层**（已删除）；组件判据同样跑
    **真实 React + @testing-library/react + jsdom**，**没有 react 测试别名/垫片**
    （`hooksStub.ts` / `jsxRuntimeStub.ts` 已于 2026-10-18 删除，别再把它们加回来）。
  - **白屏排查顺序**：`web/dist/index.html` 在不在 → 它引用的 `assets/index-*.js` 在不在
    （serve 优先托管 `web/dist`；无产物时回落 `web/`，那就必然白屏）。
- **前端判据单独一条命令**：`npm run web:test`（先 `vite build` 再 `vitest run`；真 Chrome 判据需要产物）。
  `vitest.config.ts` 已设 `fileParallelism: false` —— 11 个判据各自起真 Chrome，并发会互相抢资源产生**假红**，
  别为了快把它改回并行。

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
