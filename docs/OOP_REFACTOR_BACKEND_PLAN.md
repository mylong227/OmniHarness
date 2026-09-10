# src/ 顶层函数 → 类收敛清单

> 盘点日期：2026-09-10 ｜ 实测：`grep -rn "^export function|^function" src --include="*.ts"` = **358 处**（对比 class 232 处）
> 目的：为「全部代码按 .ts 标准面向对象实现」提供分级收敛清单。本轮 UI 改造先行，后端按本清单分模块推进。

---

## 0. 收敛判据（先立规矩，避免为 OO 而 OO）

不是所有顶层函数都该变成类。按三条判据分流：

| 判据 | 结论 | 处理 |
|---|---|---|
| **纯函数**（输入→输出，无状态、无 IO、无外部依赖） | **应保持函数** | 放进同名 `*Utils`/命名空间模块，或改为某个类的 `static` 方法（仅为了归拢），**不得为 OO 而 OO** |
| **带隐式状态**（依赖模块级变量 / 缓存 / 单例） | **应收敛为类** | 状态改为实例字段，消除模块级可变全局 |
| **一族内聚操作**（同前缀、同数据结构、同领域） | **应收敛为类** | 数据结构 + 操作绑定为类的方法 |

铁律：**收敛不得改变行为**，每模块改完必须跑对应单测 + 全量门禁。

---

## 1. 顶层函数密度 Top 18（按文件）

| 文件 | 顶层函数数 | 初判 | 建议 |
|---|---:|---|---|
| `src/enterprise/sso.ts` | 10 | 一族内聚（OIDC 流程） | 收敛为 `SsoFlow` / `OidcClient` 类 |
| `src/config/configBuilders.ts` | 10 | Builder 族 | 已有 Builder 语义 → 收敛为 `ConfigBuilder` 类（链式） |
| `src/cli/doctor.ts` | 10 | 检查项族 | 收敛为 `DoctorCheck` 抽象 + 各检查子类 / `DiagnosticRunner` |
| `src/context/repoMapContext.ts` | 9 | 带缓存状态 | **优先**：模块级 TTL 缓存 → `RepoMapCache` 类 |
| `src/context/prefixStability.ts` | 9 | 纯算法族 | 归为 `PrefixStability` 静态类（保持无状态） |
| `src/util/unifiedDiff.ts` | 8 | 纯算法 | 保持函数 或 归为 `UnifiedDiff` 静态类（低优先） |
| `src/util/commandCanonicalizer.ts` | 8 | 纯算法 | 归为 `CommandCanonicalizer` 类（可缓存正则） |
| `src/skill/skillComposer.ts` | 8 | 一族内聚 | `SkillComposer` 类 |
| `src/genesis/modality.ts` | 8 | 领域枚举族 | `Modality` 值对象 + 静态工厂 |
| `src/context/deterministicCompressor.ts` | 8 | 带状态（压缩窗口） | `DeterministicCompressor` 类 |
| `src/cli/args.ts` | 8 | 解析族 | `ArgParser` 类（消除模块级正则常量散落） |
| `src/util/eigenspectrum.ts` | 7 | 纯数学 | 静态类（低优先） |
| `src/tui/render.ts` | 7 | 渲染族 | `TuiRenderer` 类 |
| `src/genesis/multimodalBridge.ts` | 7 | 桥接族 | `MultimodalBridge` 类 |
| `src/context/lsaRecall.ts` | 7 | 带状态（索引） | **优先**（且该模块长期 0 测试，收敛时补测） |
| `src/server/auditExport.ts` | 6 | 导出族 | `AuditExporter` 类 |
| `src/security/ssrfGuard.ts` | 6 | 安全判定 | `SsrfGuard` 类（**改动需谨慎，必须补单测**） |
| `src/plugin/bundle.ts` | 6 | 打包族 | `PluginBundler` 类 |

---

## 2. 分批推进计划

### 批次 A — 高价值（带状态 / 零测试 / 安全敏感）
1. `context/repoMapContext.ts`（模块级 TTL 缓存 → 类）
2. `context/lsaRecall.ts`（长期 0 测试，收敛同时补单测）
3. `context/deterministicCompressor.ts`（压缩状态 → 类）
4. `security/ssrfGuard.ts`（安全判定，收敛必须配套单测锁行为）

### 批次 B — 内聚族（机械收敛，风险低）
5. `config/configBuilders.ts` → `ConfigBuilder` 链式类
6. `cli/doctor.ts` → `DoctorCheck` 抽象 + 子类
7. `cli/args.ts` → `ArgParser`
8. `skill/skillComposer.ts` → `SkillComposer`
9. `genesis/*`（modality / multimodalBridge）
10. `server/auditExport.ts` → `AuditExporter`
11. `plugin/bundle.ts` → `PluginBundler`
12. `tui/render.ts` → `TuiRenderer`

### 批次 C — 纯算法（仅归拢为静态类，低风险低收益，可最后做或维持原状）
13. `util/unifiedDiff.ts`、`util/commandCanonicalizer.ts`、`util/eigenspectrum.ts`、`context/prefixStability.ts`
→ 建议：改为 `static` 方法归拢到同名类，**行为零变更**，仅为结构一致性。

---

## 3. 风险提示

- **热区回避**：`src/core/stepRunner.ts`、`turnRunner.ts`、`adapters/live/**`、`ports/toolInputSink.ts` 可能被并发会话改写，动手前必查 mtime。
- **安全相关改动不得静默**：`ssrfGuard` / 沙箱 / 审批路径的收敛，必须补「合法值不被过度收紧 + 非法值必须拒绝」双向单测。
- **纯函数强转类会降低可读性**，批次 C 若执行，务必保留原函数的输入输出语义与 JSDoc。
