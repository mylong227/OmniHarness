# API 稳定性分级契约（OmniHarness）

> 对标成熟 harness（OpenAI Codex CLI / Claude Code）的公开 API 稳定性分层：
> 调用方应能从一个标签判断「这个 API 我能不能放心依赖」。

## 为什么需要

没有稳定性标注，调用方无法区分「写进合同、承诺不破」的 API 与「我写着玩、下个版本可能就没了」的 API。
本仓库公开桶 `src/index.ts` 是唯一的外部契约面，因此要求其中**每一项 export 都必须显式标注稳定性**。

## 四级标签

| 标签          | 含义         | 版本承诺                                             |
| ------------- | ------------ | ---------------------------------------------------- |
| `@public`     | 稳定公开 API | 纳入语义化版本合同，破坏性变更走主版本号             |
| `@beta`       | 实验性 API   | 可能随时增删改，**不**触发版本号变更；调用方自担风险 |
| `@deprecated` | 已废弃       | 标记者将在未来版本移除，需同时给出替代方案           |
| `@internal`   | 内部实现     | 不出现在公开桶；仅供本仓库内部使用，随时可破         |

注：`@internal` 表示「不进入公开桶」，因此校验器实际只校验 `@public` / `@beta` / `@deprecated` 三档分区。

## 标注规则（机器强制）

校验器 `scripts/apiStability.mjs`（零依赖）扫描 `src/index.ts`：

1. 每个**分区注释**必须以 `// @public` / `// @beta` / `// @deprecated` 声明该区稳定性；
2. 其下所有 `export` 语句**继承**该分区稳定性；
3. 单条 export 也可用同行 `/** @x */` 覆盖分区标注；
4. 任何 export 若不在带标注的分区内 → **违规，CI 门禁阻断（exit 1）**。

### 示例

```ts
// @public 核心
export { Agent } from './core/agent.js';

// @beta 自主目标循环（#S30）
export { GoalRunner } from './autonomy/goalRunner.js';

// @deprecated 旧实现（已被 GoalRunner 取代）
export { LegacyGoalLoop } from './autonomy/legacyGoalLoop.js';

// 单条覆盖：即便落在 @public 分区，也可显式标 @beta
/** @beta */ export { experimentalThing } from './x.js';
```

当前分级（节选）：

- **`@public`**：端口层、核心、配置、适配器、hooks 兼容层、上下文/工具、插件系统、门禁/PTC、Skills、app-server/协议、schema/SDK、worker 编排、MCP 网关、原生内核、企业管控、版本契约。
- **`@beta`**：工具语义检索(M1)、会话检索(M2)、子智能体(#76)、自主目标循环(S30)、工作流 DAG(S31)、LSP(S32)、Agent 密码学身份(S33)、安全策略求值(S34)、零依赖 TUI(S35)、计划/待办/提问(#77)、评估基准(C3)。
- **`@deprecated`**：截至 2026-09-02，**公开桶尚无废弃导出**。本仓库仍处早期快速演进阶段，未积累到需废弃的公开 API——这是健康态，不是缺口。废弃机制（标签 + 校验器 + 版本策略）已就位：一旦某 API 被取代，直接在其分区标注 `// @deprecated` 并给出替代方案即可，校验器不会因此报错。

## 物理落地：双桶拆分

稳定性分级不是文档标语，而是**真实的导入边界**：

- **稳定 API** → `src/index.ts`，包根导入：`import { Agent } from 'omniharness'`
- **实验 API** → `src/indexBeta.ts`，子路径导入：`import { GoalRunner } from 'omniharness/beta'`

`package.json` 的 `exports` 同时暴露 `.` 与 `./beta`。两桶各自独立接受 `scripts/apiStability.mjs` 校验，
任一桶出现「未标注分区的 export」即阻断 CI。

## 版本锚点

`src/version.ts` 导出 `API_VERSION`（当前 `0.1.0`），作为合同版本号锚点，随 `@public` API 演进 bump。

## 本地校验

```bash
npm run api:check      # 扫描 src/index.ts，违规即非零退出
node scripts/apiStability.mjs <任意桶文件>   # 也可指向其它桶做检查
```
