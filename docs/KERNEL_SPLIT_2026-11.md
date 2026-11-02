# 切分方案：从 OmniHarness 切出「内核项目」（2026-11）

> **性质**：架构切分执行方案（带日期快照）。
> **我理解的诉求**（若不对请先纠正我）：**OmniHarness 继续作为「应用」存在**；**另切出一个新项目承接
> [FORK_READINESS](FORK_READINESS_2026-11.md) 里那套 kernel / contracts / apps 架构**，两者是「内核 ↔ 第一个消费者」的关系。
> **预算**：10 h/周。**前置**：[可维护性治理](MAINTAINABILITY_PLAN_2026-11.md) 的 P0 止血（6 周）。
> **不做**：不在切分的同时改行为；不现在就拆第二个 git 仓库（理由见 §4）。

---

## 0. 结论先说

| 问题 | 结论 |
| ---- | ---- |
| 切什么 | 把 `contracts`（端口/事件/schema）与 `kernel`（主循环/上下文/工具/门禁/审计）切出来，成为**有独立名字、版本、README、契约测试**的项目 |
| 不切什么 | CLI / Web / Desktop / HTTP server / 商业授权 —— 留在 OmniHarness，作为**第一个消费者** |
| 怎么切 | **先目录分层 + 机器门禁**（同仓），**再**视需要升级为 npm 包，**最后才**考虑独立仓库 |
| 为什么不是一上来就双仓 | 双仓在单人 10h/周 下必然漂移：两套 CI、两套 issue、两份依赖、版本对齐靠人肉。**同仓多包能拿到 90% 的收益，付 10% 的成本** |
| 新项目何时「真的存在」 | 它从第一天就以 `kernel/` 目录 + 独立版本号 + 契约测试存在；**「可被外部安装」是它的成熟形态，不是起点** |
| 总工时 | 前置 56 h（还债）+ 切分 68 h ≈ **124 h ≈ 13 周** |

**一句话**：**这个新项目不是「另起一个仓库」，是「把内核从应用里长出来、并让它长出边界」。**

> ⚠️ **先接受一个数字**：按下面 §2 的归属切下来，内核是 **113,012 行（全仓 65%）**。
> **切分不减少一行代码，也不降低复杂度**——它只是把「谁属于谁」画清楚。
> 真正的减重在 [可维护性方案](MAINTAINABILITY_PLAN_2026-11.md) 的 A2/A6（adapters 收敛 + 死面清理）。
> 如果指望"切出内核"能让项目变轻，那一定会失望；它的收益是**边界**，不是**体积**。

---

## 1. 现状：边界已经有一半，只是没画出来

这个仓库其实**已经具备切分的基础**，比大多数项目强：

| 已有地基 | 证据 |
| -------- | ---- |
| 端口层 | `src/ports/` 411 个文件 / 10,462 行，覆盖 28 个领域 |
| 稳定性分级 + 机器强制 | `src/index.ts`（`@public`/`@beta`）+ `scripts/apiStability.mjs` |
| 依赖方向门禁 | `arch:gate`（当前：违规 0、ports 纯度 0、依赖环 4 组） |
| 配置/装配分离 | `src/config` 装配 + `src/composition` 组合根 |
| 协议入口 | ACP / MCP / A2A / AG-UI 已经是独立目录 |
| 双桶导出 | `.` 与 `./beta` 子路径 |

**缺的不是技术，是「谁属于谁」的显式声明**：40 个模块平铺在 `src/` 下，新人和三个月后的你都看不出
哪一块是内核、哪一块是外壳。

---

## 2. 边界：40 个模块各归其位

按行数（物理行，2026-11-02 实测）与实际依赖关系归属。**这一节是切分的契约**。

### 2.1 `contracts`（新项目的第一块，11,345 行）

> 规则：**零实现**，只允许类型、常量、端口接口、schema。任何 `import` 到实现层都是违规。

| 模块 | 行数 | 说明 |
| ---- | ---- | ---- |
| `ports` | 10,462 | 28 个领域的端口接口（唯一大件） |
| `schema` | 487 | 配置/事件 schema |
| `errors` | 126 | 错误码与类型 |
| `sdk` | 270 | 外部 SDK 的类型面 |

### 2.2 `kernel`（113,012 行 = 全仓 65%，内部再分 8 个子域）

> 规则：**只依赖 `contracts`**；不知道 CLI、不知道 HTTP、不知道 React。

| 子域 | 组成 | 行数 | 备注 |
| ---- | ---- | ---- | ---- |
| 执行循环 | `core` | 9,822 | 主循环/步进/完成判定 |
| 上下文 | `context` + `adapters/memory` + `adapters/embedding` + `adapters/spill` | 18,209 | 压缩/检索/外溢 |
| 工具运行时 | `adapters/tool` + `plugin` + `skill` + `capability` | 23,143 | **最大子域**，也是二开第一入口 |
| 安全与审批 | `security` + `governance` + `adapters/{sandbox,approval,policy,escalation,isolation}` | 7,217 | fail-closed 的核心资产 |
| 存储与审计 | `observability` + `adapters/{storage,event,vault,kv,telemetry}` | 3,754 | 哈希链/事件流 |
| 模型与外部能力 | `media` + `adapters/{model,browser,media,lsp}` | 15,682 | **按 3 族收敛后 ≈11K** |
| 编排 | `subagent` + `autonomy` + `supervisor` + `worker` + `adapters/schedule` | 5,223 | 子代理/目标循环 |
| 共享底座 | `util` + `config` + `search` + `native` + `asset` + `eval` + `evolution` + `genesis` + `spark` | 26,719 | 含全部 `@beta` 实验件 |
| 零散 | 其余小适配器 | ≈3,200 | 逐一定位 |

### 2.3 `protocols`（15,653 行，可作为 kernel 的可选子包）

`acp`（2,833）+ `mcp`（6,928）+ `a2a`（4,246）+ `agui`（1,646）；另有 `adapters/mcp` 1,549 行为两可项
（进 protocols 更纯，进 kernel 更省一次拆包）。

**为什么单列**：协议是对外的「嘴」，会跟着标准变；把它与内核解耦，标准升级时不牵动循环。

### 2.4 `apps`（留在 OmniHarness，31,463 行）

`cli` 13,072 + `server` 13,065 + `tui` 530 + `daemon` 749 + `license` 577 + `enterprise` 736 +
`composition` 573 + `hooksCompat` 181 + `output` 32 + `(root)` 674 + `adapters/{enterprise,user,monitoring,live}` 1,720。

> 规则：**只准通过 `kernel/index.ts` 与 `contracts/index.ts` 依赖**，禁止直达内部文件。这条由 `arch:gate` 强制。

### 2.5 待裁决（切分时顺手处理，别带进新项目）

| 项 | 行数 | 建议 |
| -- | ---- | ---- |
| `adapters/laya` | 1,665 | **移出 kernel**：依赖第三方 venv 与模型权重，不是通用内核能力 |
| `adapters/user` | 153 | 归 `apps`（用户画像不是内核概念） |
| `adapters/monitoring` | 358 | 归 `apps`（运维面） |
| `adapters/live` | 168 | 归 `apps`（实时推送属传输层） |
| `adapters/belief` | 429 | 若无人消费则删（属"命名好听"类） |
| `spark` / `genesis` | 1,884 | 保留在 kernel 但默认关；契约里标 `@beta` |

---

## 3. 依赖规则（切分的真正内容）

```
apps ──▶ kernel ──▶ contracts
  │         │
  └────────▶└──────▶ protocols（可选反向：protocols ──▶ kernel 的公开入口）
```

四条硬规则，每条都能机检：

1. **禁止回指**：`contracts` 不得 import `kernel`/`apps`；`kernel` 不得 import `apps`。
2. **禁止穿透**：`apps` 不得 import `kernel/内部路径`，只能 `kernel/index.ts`。
3. **契约纯净**：`contracts` 内不得出现 `new`、`fs`、`http`、`child_process` 等实现符号。
4. **协议隔离**：`protocols` 不得 import `apps`；`kernel` 不得 import `protocols`（内核不知道有 ACP）。

**落地方式**（沿用现有 `arch:gate`，不新造工具）：把上面四条写成层规则，先在**白名单模式**跑（存量放行、
新增即红），逐批清零后切 `--strict`。这与仓库既有的「依赖环白名单只降不升」是同一套机制。

---

## 4. 三种切法：为什么先目录、后包、最后才仓库

| 方案 | 成本 | 拿到什么 | 拿不到什么 | 判定 |
| ---- | ---- | -------- | ---------- | ---- |
| **A. 目录分层 + 门禁**（同仓） | ~24 h | 边界、可读性、独立版本、契约测试、可发布 | 独立 star/issue；独立 CI | ✅ **第一步** |
| **B. npm workspaces 三包** | ~44 h（增量） | 独立 `npm pack` 与 semver；下游能 `npm i` | 独立仓库与社区 | ⏸ 有外部消费者时再做 |
| **C. 独立 git 仓库** | ~30 h/年**持续**（同步、对齐、双 CI） | 独立叙事与社区 | 不解决任何技术问题 | ❌ 现在不做 |

**关键论据**：A 与 B 的差别只在「发布单元」，不在「架构」。而 C 在单人 10h/周 下的真实成本是
**每次改动都要回答"这个改动属于哪个仓、两边版本怎么对齐"**——这正是 [可维护性方案](MAINTAINABILITY_PLAN_2026-11.md)
要消灭的那类固定成本。

**B 的触发条件**（三条同时满足才做）：① 有一个真实外部消费者要 `npm i`；② 契约测试 ≥20 例且全绿；
③ 可维护性 P0 已完成。否则 B 只是把「目录」换成「package.json」，收益为零、成本提前付。

---

## 5. 迁移步骤（每步：一个 commit、回归绿、可 revert）

### S0 前置：还债（56 h，6 周）

先做可维护性 P0。**理由**：切包要移动 1,305 个文件的 import（4,324 条相对导入边），
如果同时还有 CI 红、版本漂移、死面待删，你分不清「移动导致的红」与「原本就红」。

### S1 立 `contracts`（16 h）

- 建 `src/contracts/`，把 `ports` / `schema` / `errors` / `sdk` 整体移入；
- 跑一次机械重写 import（脚本 + `tsc` 兜底），**不改任何逻辑**；
- `arch:gate` 加规则 3（契约纯净）。
- **判据**：`regress` 绿；`contracts` 内零 `fs/http/new`；依赖图无回指。

### S2 立 `kernel`（24 h）

- 按 §2.2 建 8 个子域目录，模块整体移入；
- `kernel/index.ts` 作为**唯一对外入口**（从 `src/index.ts` 收敛，公开面同时收缩到 ≤60）；
- `arch:gate` 加规则 1、2。
- **判据**：`kernel` 内零 `apps` 引用；`apps` 侧零 `kernel/内部` 引用（白名单外）。

### S3 收口 `apps`（12 h）

- `cli` / `server` / `tui` / `daemon` 改为只 import 两个入口；
- 删掉穿透 import（预计 30–60 处），逐批清白名单。
- **判据**：白名单为空；`arch:gate --strict` 绿。

### S4 契约测试 + 独立发布（16 h）

- `tests/contract/`：用 **kernel 公开 API** 写 20 例行为契约（mock 模型下的循环、工具门禁拒绝理由、
  会话落盘与回放、事件顺序、压缩不变量）；
- **20 行 headless 示例**：不引用 apps，直接 `import { Agent } from '../kernel'` 跑通一次任务；
- `npm pack` kernel，在空目录安装运行。
- **判据**：删掉 `apps` 后，20 例契约 + headless 示例仍全绿（这就是"内核独立存在"的证明）。

### S5 新项目的身份（8 h）

- kernel 目录的 README（S5 产物）：**一句话定位 + 四个不变量 + 扩展点索引 + 兼容承诺**；
- 独立版本号 `KERNEL_VERSION`（与 `API_VERSION` 的关系写清：一个是包、一个是契约）；
- 发布到 npm 作为 `@omniharness/kernel`（**先做 alpha**，不承诺支持）；
- `CHANGELOG` 分家：kernel 的变更与 app 的变更分开记。

**累计 68 h**，加上前置 56 h = **124 h ≈ 13 周**。

---

## 6. 新项目的身份定义（建议）

| 项 | 建议值 | 理由 |
| -- | ------ | ---- |
| 品牌名 | **OmniKernel** | 与 OmniHarness 同族但可区分；叫 `core` 容易与 `src/core` 混淆 |
| 包名 | `@omniharness/kernel` + `@omniharness/contracts` | 保持作用域统一，一个 npm 组织 |
| 一句话 | **可嵌入的 agent 内核：可审计、fail-closed、模型中立** | 与 app 的"工作台"叙事错开 |
| 版本策略 | kernel 独立 semver；app 依赖固定 minor | 避免"app 一改就要升 kernel" |
| 兼容承诺 | `contracts` 严格 semver；kernel 公开入口次版本兼容；内部不承诺 | 与 `API_STABILITY.md` 四级标签对齐 |
| 与 OmniHarness 关系 | **OmniHarness 是它的第一个消费者与参考实现** | 这句话同时解释了为什么 app 不搬走 |

### 6.1 两个项目各自的成功判据（防止再次漂移）

| 项目 | 它是什么 | 成功判据（D90 / D180） | 明确不是 |
| ---- | -------- | ---------------------- | -------- |
| **OmniKernel** | 可嵌入内核 + 契约 | 删掉 app 仍能跑（契约测试 20 例 + 20 行 headless）；`npm pack` 可装；D180 有 ≥1 个外部安装 | 不是"第二个功能更多的 harness" |
| **OmniHarness** | 参考应用 + 工作台 | 5 分钟跑通；审计出证可用；fork 数 ≥5 | 不是"内核的上游依赖"（方向只能是 app → kernel） |

**一句话记法**：**内核卖「边界」，应用卖「体验」；应用不准反过来改造内核的内部。**

---

## 7. 风险

| 风险 | 说明 | 对策 |
| ---- | ---- | ---- |
| 切包期间回归变红，分不清成因 | 移动 import 会制造大量红 | S0 先还债；每步只做一种变更（纯移动 vs 逻辑改） |
| `kernel` 越切越肥 | 86K 行的"内核"听起来像第二个单体 | 8 个子域各自 ≤15K，且由 `maintainability.mjs` 的模块预算兜住 |
| 契约面又长回去 | 242 → 60 的努力被"顺手 export"抵消 | `@public` 计数门禁；新增导出必须写"谁会用" |
| 新项目没人用 | 切出来只是自娱 | 先有 headless 示例 + npm alpha，再看有没有外部安装；没有就**不升级到 B/C** |
| 双份文档 | README/CHANGELOG/版本说明各写一遍 | kernel 只保留 4 份文档（README/ARCHITECTURE/EXTENDING/CHANGELOG），其余链接到主仓 |
| 与自进化/企业功能纠缠 | `evolution`、`enterprise` 跨边界 | `enterprise` 归 app；`evolution` 留 kernel 但 `@beta` + 默认关 |

---

## 8. 什么算「切成功」

五条，缺一条都算没切完：

1. `apps` 对 `kernel` 的 import **零穿透**（`arch:gate --strict` 绿）；
2. `contracts` 零实现依赖（无 `fs`/`http`/`new`/`child_process`）；
3. 删掉 `apps` 目录后，20 例契约测试 + 20 行 headless 示例**仍全绿**；
4. `kernel` 能被 `npm pack` 并在空目录安装运行；
5. 一个没读过代码的人，按 kernel 目录下的 README（规划产物） 能在 10 分钟内写出一个 headless 调用。

**第 3 条是唯一不可替代的证明**：内核的独立性不是靠目录名，是靠"把应用删了它还能跑"。

---

## 9. 与另外两份文档的关系

- [MAINTAINABILITY_PLAN_2026-11.md](MAINTAINABILITY_PLAN_2026-11.md)：**前置**。没有它，切分只会把 205 h 的债复制成两份。
- [FORK_READINESS_2026-11.md](FORK_READINESS_2026-11.md)：**同源**。二开友好的五类扩展点，正是 kernel 对外的接口；
  本方案的 S1–S4 是那份文档 P0 的架构化实现。
- [STRATEGY_2026-11-02.md](STRATEGY_2026-11-02.md)：**上位**。切出来的 kernel 是「可审计执行底座」的物理形态；
  §6 的审计出证器将是它上面的第一个独立工具。

---

## 10. 如果你其实想要的是「另起炉灶重写」

有一种不同的读法：**不复用现有代码，按新架构从零写一个新项目**，现有仓库冻结为应用。
若是这个意思，本方案 §2–§5 的边界表仍然有效（它就是"新项目该有什么"的清单），但代价完全不同：

- 现有 86K 行内核能力**全部作废重写**（约 3–6 个月，10h/周 下不现实）；
- 但会得到一个「从未被 205 h 债污染」的干净内核。

**我的建议是不要**：你的债务不在代码里，在**结构**里；而结构可以就地改（§5），不需要重写。
重写只能消除"理解成本"，不能消除"维护成本"——而后者才是 10h/周的杀手。
