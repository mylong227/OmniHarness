# 贡献指南

## 铁律（不可妥协）

- 代码用 TypeScript（`src/`），ESM，严格模式
- **一个功能一个类**；**一个函数一个职责**；禁止大函数
- **文件命名一律 camelCase（驼峰），拒绝下划线与连字符**（例外：`index.ts` 作目录聚合出口，可无同名主类）
- **依赖准入制（D10）**：运行时**不是零依赖**——`dependencies` 5 个（`@modelcontextprotocol/sdk` / `croner` / `jose` / `openid-client` / `zod`）+ `optionalDependencies` 2 个（`@huggingface/transformers` / `sharp`）；devDependencies 也远不止两个（typescript、@types/*、eslint 族、prettier、@changesets/cli，以 `package.json` 为准）。任何第三方依赖/裸导入都要先登记进 `dependency-allowlist.json`（见 [DEPENDENCY_POLICY.md](DEPENDENCY_POLICY.md)），未登记即阻断
- 核心只依赖端口接口，不依赖具体实现

## 开发流程

```bash
npm install
npm run install-hooks # 激活提交钩子（首次一次；此后 pre-commit 自动跑门禁）
npm run build         # tsc 构建
npm test              # 单元测试（node:test，无第三方测试框架）
npm run gate:typed    # 类型层门禁（tsc --noEmit + 类型感知 eslint）
npm run check:doc-links # 文档死链
npm run smoke         # 冒烟
npm run stress        # 压测（内存泄漏检查）
```

> **门禁只有一处实现**：`scripts/runGates.mjs`（`fast` 层 10 项 + `typed` 层 2 项）。
> `pre-commit` 只是它的薄包装（`--hook`），`npm run gate:typed`（= `lint:typed`）跑类型层。
> **要加/改门禁只改那一份文件**——往文档或钩子里抄第二份清单，抄的时候就会漂。
> 其余验证脚本（`test:integration` / `smoke:real` / `smoke:model` / `smoke:ui` / `web:test` / `coverage`）
> 以 `package.json` 的 `scripts` 为准。

## 添加新功能

1. 判断功能归属：端口？适配器？核心？扩展层？
2. 新增文件遵循 camelCase 命名；一个功能一个类
3. 补单元测试（tests/unit/）
4. 跑 `npm test` + `npm run smoke` 回归，确认不破坏既有功能
5. 更新 README / 对应 docs

## 修改端口

端口接口在 `src/ports/`。修改端口 = 破坏性变更：

- 新能力用**可选方法**（如 `stream?`）避免破坏既有实现
- 若必须加必需方法，同步更新全部内置适配器
- 更新架构文档 `docs/ARCHITECTURE_SPEC.md`

## 提交规范

- 提交信息：`类型: 简述`（feat/fix/docs/refactor/test/chore）
- 每步一个提交，保持历史可读

## 本机状态与用户级配置（`~/.omniharness/`，勿提交）

有一批开发期状态**故意不在仓库里**，它们落在**用户级**目录 `~/.omniharness/`：

- `omniharness.json`：用户级配置。**凭据只放这里**（`providerKeys`，CLI 按 `modelAdapter` 命中的厂商自动补全
  顶层 `apiKey` / `baseUrl`）——项目级 `omniharness.json` 要进版本库，写进去等于把密钥提交上去；
- `sessions/`：会话存档（**全局**，按 `session_meta.payload.workspace` 标记归属；`sessions.list` 缺省只回当前项目）；
- `plugins/`、`profiles/`、`routines.json`、`daemon.pid`：插件目录 / 命名插件组合 / 例程 / 守护进程 PID，同理。

**为什么单列一节**：这些路径既不会被 `git status` 看见，也不会被任何"文档与磁盘一致"的判据拦住。
"我这里明明配了却不生效"多半是**配置写错了层**——配置分层链（内置默认 → 用户级 → 项目级 → `--profile` →
bundle 补丁 → 环境变量 → CLI）与 serve 的工作区根解析见 [integration.md](integration.md) §6。
另外：`workspace` / `workspaces` **只写用户级**，家目录下的路径写回时压成 `~/…`（可移植路径）；
自己产生的本机文件**不要提交**。
