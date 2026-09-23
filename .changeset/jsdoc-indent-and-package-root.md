---
'omniharness': patch
---

配置化收尾三件：包根定位改为「包根锚点」、全仓 JSDoc 脱块修复 + 新标准规则、临时脚本清理。

**1. `util/builtinDefaults.ts` 的包根定位不再写死级数**（上一轮登记为「刻意不做」，本轮改为有锚点的实现）：
原先 `resolve(dirname(import.meta.url), '../../..', 'defaults')` 只对 `dist/src/**`（测试与发布布局）正确，
源码布局（`src/util/`）会解析到仓库**父目录**。现改为 `BuiltinDefaults.locatePackageRoot()`：从模块自身目录
向上逐级查找**同时含 `package.json` 与 `defaults/`** 的那一级（最近者胜，上限 4 级），两种布局都命中。

**为什么这不是 fail-open**：若只找名为 `defaults/` 的目录，一旦某一级父目录碰巧存在同名目录就会**静默读到
别人的数据**；要求同级存在 `package.json` 作为包根身份锚点后，命中的必然是本包根，向上 4 级仍找不到就
**当场抛错**（而不是拿一个猜出来的相对路径去读）。回归测试覆盖：随包布局、源码布局、只有 `defaults/` 而
无 `package.json`（必须抛错）、向上有界（深目录必须抛错）、嵌套包根取最近者。

**2. JSDoc「注释脱块」清零 + 新标准规则（`auditStandards` 第 12 项）**：全仓 **31 个文件 / 94 行**的
JSDoc 续行缩进不等于「注释起始列 + 1」——即历史上自动补写 `@returns 无返回值。` 时被追加到**注释块外**
（`*` 与 `*/` 缩进为 0–2，而块首 `/**` 在第 2 列），Prettier 不管 JSDoc 缩进、原门禁也不查，故长期存在。
现一次性机器修复并把规则接入 `auditStandards.mjs`：`--delta` 增量门禁**只增即红**，全量审计在 SUMMARY
打印该度量，另加 `tests/unit/standardsJsdocIndent.test.ts` 钉住「度量已接线 + 真实仓库为 0」。

**刻意不做的相反方向（附理由）**：本规则**不**禁止 `void` 方法写 `@returns 无返回值。`——`auditStandards`
增量门禁的「方法缺@returns」项把「有显式返回类型的方法」（含 `void` / `Promise<void>`）计入分母，
`@returns 无返回值。` 正是满足该项的合规写法；要改这条政策，须先改那条门禁的口径（属独立决策，不在本笔）。

**3. 清理**：删除本轮一次性 codemod 脚本（`scripts/tmpJsdocIndentFix.mjs` 等，脚本自述「跑完即删」）。
codemod 第一版按注释 token 起点累加行长算偏移，导致替换位置右移 `openCol` 个字符、把正文改坏
（`@returns 无返   回值。`）；已回滚那 31 个文件后重写为「按整行偏移 + 改完自证 0 违约才写入」。

**验证**：见看板 §20.15；`check --strict`、`arch:gate`、`audit:config-wiring`（七条不变量＋selftest）、
`audit:maturity`、`audit:standard --delta`、`lint`、`format:check`、`tsc --noEmit`（含 web）与全量单测全绿。
