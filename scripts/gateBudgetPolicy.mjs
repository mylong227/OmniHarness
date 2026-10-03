/**
 * 门禁分层**策略常量**（G27/TS3，2026-10-03 第十六轮）。
 *
 * 本文件**无副作用**（只有常量与类型），因此可被两条路径同时引用而不会触发测量：
 *  - `scripts/gateBudget.mjs`（实测并断言预算）；
 *  - `tests/unit/gateTiering.test.ts`（结构判据：断言预算与规则清单**没被悄悄改宽**）。
 *
 * 为什么单列而不写进 `gateBudget.mjs`：那个脚本**一被 import 就会跑完整测量**（~45 s），
 * 于是测试只能去读文本、正则匹配数字——那是"钉住字符串"而不是"钉住契约"（本仓已因这类
 * 间接断言吃过假绿：见 G23 的 `@ts-expect-error` 教训）。拆出常量后，测试可以直接断真值。
 */

/** 快层预算：`eslint .`（不含类型信息）上限，秒。 */
export const FAST_BUDGET_SECONDS = 65;

/** 类型层预算：`tsc --noEmit` + 类型感知 eslint 的**实测秒数之和**上限。 */
export const TYPED_BUDGET_SECONDS = 45;

/** 层标识：`fast` = 不需要类型信息；`typed` = 需要类型信息。 */
export const GATE_TIERS = ['fast', 'typed'];

/**
 * 类型感知层启用的规则（**必须是"没有类型信息就判不了"的规则**）。
 *
 * 判据为什么钉这份清单：把一条普通规则挪进类型层会白白让它付出 ~26 s 的建程序代价；
 * 反过来漏掉一条真需要类型的规则，则类型层名不副实。
 */
export const TYPED_ONLY_RULES = [
  '@typescript-eslint/no-floating-promises',
  '@typescript-eslint/await-thenable',
  '@typescript-eslint/no-misused-promises',
];

/** 类型感知层配置文件名（`runGates.mjs` 的 `eslint-typed` 门禁与预算脚本共用）。 */
export const TYPED_CONFIG_FILE = 'eslint.typed.config.mjs';
