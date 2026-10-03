/**
 * `scripts/gateBudgetPolicy.mjs` 的类型声明（G27）。
 *
 * ## 为什么用**字面量类型**声明预算
 *
 * `tsconfig.json` 不启用 `allowJs`（本仓只编译 `src/**`、`tests/**`、`examples/**` 的 `.ts`），
 * 所以 `.mjs` 实现与这份声明之间**没有自动一致性检查**。把预算写成字面量类型（`65` / `45`）后：
 *  - 类型侧钉住"就是这两个数"（改实现不改声明 = 运行期断言会红，见 `tests/unit/gateTiering.test.ts` ⑥）；
 *  - 调用方（预算脚本、测试）拿到的是字面量而不是 `number`，`if (x > BUDGET)` 这类比较一眼可读。
 */
export declare const FAST_BUDGET_SECONDS: 65;
export declare const TYPED_BUDGET_SECONDS: 45;
export declare const GATE_TIERS: readonly ['fast', 'typed'];
export declare const TYPED_ONLY_RULES: readonly [
  '@typescript-eslint/no-floating-promises',
  '@typescript-eslint/await-thenable',
  '@typescript-eslint/no-misused-promises',
];
export declare const TYPED_CONFIG_FILE: 'eslint.typed.config.mjs';
