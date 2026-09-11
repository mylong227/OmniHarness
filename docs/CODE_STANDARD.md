# OmniHarness 代码规范（Code Standard）

> 本标准是仓库级强制约定，适用于**全部 `.ts` 源码**（`src/`、`tests/`、`web/src/`）。
> 由 ESLint 门禁（`npm run lint`）与 TypeScript 严格模式共同保障；能机械校验的一律上闸门，
> 不能机械校验的（封装、职责、设计模式）在评审批次中人工把关。

## 0. 与工程铁律的关系

本标准是既有工程铁律（TS + ESM + strict、零/准入依赖、六边形端口-适配器、无硬编码绝对路径）
的**细化补充**，不与之冲突。冲突时以既有铁律为准。

## 1. 类模板（唯一标准形态）

```ts
/**
 * <一句话说明这个类负责什么单一职责>。
 */
export class FileName {
  /** <私有常量/依赖说明>。 */
  private readonly dep: Dep;

  /**
   * <构造函数职责说明>。
   * @param dep 依赖注入（构造注入，禁止 `new` 具体实现于方法内）。
   */
  public constructor(dep: Dep) {
    this.dep = dep;
  }

  /**
   * <公开方法职责说明>。
   * @param input 入参含义
   * @returns 返回值含义
   */
  public run(input: string): Result {
    // ...
  }
}
```

### 强制规则

| 规则 | 要求 | 门禁 |
|---|---|---|
| **访问权限** | 每个类成员必须显式写 `public`/`private`/`protected`，禁止隐式 public | `explicit-member-accessibility: error` |
| **变量声明** | 禁止 `var`；只用 `const`，必要时 `let` | `no-var: error` |
| **禁用 any** | 禁止 `any`（含 `: any`、`as any`、`<any>`），用 `unknown` + 收窄 | `no-explicit-any: error` |
| **类型标注** | 公开方法的入参、返回值必须显式标注 | `tsc --strict` |
| **杜绝上帝类** | 单文件 ≤ 800 行（2026-09-12 起，架构稳定优先于机械拆分）、单类 ≤ 20 个方法为宜；超限须拆分 | 人工评审 + `check.mjs` |
| **文件名 = 类名** | 一个文件一个主类，主类名与文件名一致（`foo.ts` → `class Foo`） | 人工评审 |
| **单一职责** | 一个类只干一件事；方法粒度单一、可单测 | 人工评审 |
| **JSDoc** | 公开类/方法/关键字段必须有 `/** */`，含 `@param`/`@returns` | 人工评审 |
| **减少 `static`** | 慎用静态成员；有状态或可注入者一律实例化 + 组合根单例 | 人工评审 |
| **组合优于继承** | 依赖通过构造注入，禁止在方法体内 `new` 具体实现 | 人工评审 |
| **控制流** | 优先早返回（guard clause）、查表/映射、多态，减少深层 `if/else` 嵌套 | 人工评审 |

## 2. 命名与文件

- 文件与目录：`camelCase.ts`（如 `repoMapContext.ts`）。
- 类：`PascalCase`，且**与文件名（去掉扩展名、首字母大写）对应**。
  - `lsaRecall.ts` → `class LsaRecall`（不再叫 `LsaEngine`）。
  - 例外：`index.ts` 作聚合出口；纯类型文件可只导出 `interface`/`type`。
- 方法/变量：`camelCase`；常量：`UPPER_SNAKE_CASE`。
- 一个文件**至多一个主类**；聚合/多实现场景拆分为一文件一类。

## 3. 职责划分（六边形架构一致性）

- `src/ports/**` 只放接口与纯类型（第三方-free、值-free）。
- `src/core/**` 只依赖端口接口，不依赖具体适配器。
- `src/adapters/**` 实现端口，是唯一允许接触外部 IO/第三方库的层。
- 组合根（`Container` + `RuntimeFactory`）负责装配，**禁止在业务方法内 `new` 具体适配器**。

## 4. 可复用 / 可移植 / 解耦

- 外部工具与依赖位置一律集中为 `CONFIG` + 环境变量派生，禁止硬编码绝对路径与散落地址（工程铁律）。
- 公共逻辑抽为独立类/工具，避免复制粘贴；跨模块复用优先走端口接口。
- 依赖方向单向：adapter → port ← core；禁止反向 import。

## 5. 设计模式使用准则

- **恰当使用**：策略（多后端/多审批）、工厂（DI 装配）、适配器（端口实现）、外观（薄门面兼容）、
  模板方法（流程骨架）等在确实降低复杂度时使用。
- **禁止过度设计**：不为模式而模式；能用函数表达清晰的纯逻辑不要硬塞成模式。
- 引入新抽象前先问：是否已有端口/适配器可用？是否增加而非减少耦合？

## 6. 效率与整洁

- 禁止冗余代码、死代码、重复实现；同一算法全库唯一。
- 避免无谓分配与深拷贝；热路径先量后优。
- 不写「屎山」：宁可多一个小而清晰的类，不可堆一个大而含糊的类。

## 7. 门禁与工具

```bash
npm run typecheck   # tsc --noEmit（strict）
npm run build       # tsc 编译
npm run web:build   # web UI 编译
npm run lint        # eslint（规范 #1/#6 机械校验）
npm test            # 全量单测
npm run api:check   # 公共 API 表面稳定性
```

- AST 盘点：`node scripts/auditStandards.mjs`（统计各规范违反量，用于跟踪收口进度）。
- 机械修复：`node scripts/codemod/memberAccessibility.mjs [--dry]`（补全显式 `public`）。
- 成熟度门禁：`node scripts/auditStandards.mjs --maturity`（见 §8；L2/L3 无测试即阻断，exit 1）。
- 成熟度标注：`node scripts/codemod/maturityAnnotate.mjs [--apply]`（幂等登记，见 §8）。

## 8. 隐喻引擎成熟度声明（命名 ≠ 机制）

本仓库有以物理/生物/化学命名的引擎（退火、免疫、涡环、QEC、结晶、对称破缺、宇宙网、CRISPR…）。
**命名不等于机制**。凡以学科概念命名的实现，必须在文件顶层 JSDoc 声明成熟度等级并给出证据——
否则文档与注释会系统性过度声明（如把记账恒等式写成「能量守恒」），最终无法被验证。

### 8.1 四个等级

| 等级 | 名称 | 判据 |
| ---- | ---- | ---- |
| **L0** | 命名级 | 只有名字像，算法是普通启发式；换名不影响行为 |
| **L1** | 结构同构 | 数据结构 / 组合律与理论对象同构，可等式推理 |
| **L2** | 动力学同构 | 演化规则与理论方程同构（同一差分 / 微分形式） |
| **L3** | 可证性质 | 理论中的定理在本实现里被单测机械证明 |

> **说 L3 必须是有测试**。没有测试的收敛性 / 守恒性声明，一律降级为 L1/L2。

### 8.2 写法（强制）

```ts
/**
 * ……（模块作用）
 *
 * @maturity L2 — 真做扩散步；冷却调度的最优性未证
 * @maturityEvidence tests/unit/heatAnnealer.test.ts
 */
```

- `@maturity`：等级 + 「—」+ 一句话判据，**必须写明为什么是这个等级，含尚未证明的部分**。
- `@maturityEvidence`：**L2/L3 必填**，指向**真正 import 该模块**的测试文件（经 re-export 导入也算）。
- 新增隐喻引擎时同步登记到 `scripts/codemod/maturityAnnotate.mjs` 的 `REGISTRY`（幂等，可反复跑）。

### 8.3 门禁

```bash
node scripts/auditStandards.mjs --maturity    # 违规 exit 1（CI gate job 已接入）
```

检查项：① 等级值合法（L0–L3）；② L2/L3 必须有证据且文件存在；③ 证据仅「提及名字」而无真实
import（如把桩数据 `const bm25 = [{id:'b'}]` 当覆盖）的，列为「名义证据」提示人工确认。

### 8.4 措辞红线

- 不得用物理定律为记账 / 启发式背书：`ledger` 是**记账不变量**（会计恒等式），**不是**能量守恒。
- `qec` 是**轨迹级校验关系 + 显式冗余**，**不涉及量子力学**；理解时读作「纠删 / 校验码」。
- 凡以 `joules` / 能量命名的估算值，必须标注「经验系数估算的代理值，非实测物理量」。
- 引用外部数字（尤其厂商自报）须标注来源与「自报，未独立复现」。

理论与分级依据：`docs/library/README.md` §4（全局映射总表）；升级主线：
`docs/TECH_DIRECTION_SYNTHESIS_2026-09-12.md` T0。

## 9. 例外与豁免

- 第三方 vendored 代码（`web/vendor/**`）不适用本标准。
- 渲染用 `web/src/types/*.d.ts` 手写 shim：同样纳入规范（已补显式修饰符、去 `any`）。
- 并行会话占用中的热区文件（`core/stepRunner.ts`、`core/turnRunner.ts`、`adapters/live/**`、
  `ports/toolInputSink.ts`）在 eslint 中以覆盖块暂缓 `explicit-member-accessibility`，待其收口后纳入。
