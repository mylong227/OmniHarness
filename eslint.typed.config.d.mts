/**
 * ESLint **类型感知层**配置的类型声明（G27）。
 *
 * 与 `eslint.config.d.mts` 同形（扁平配置数组）；判据要断言的是本层**确实**给了
 * `parserOptions.project`、作用域是 `src/**`、规则集逐字等于策略清单。
 */
export interface TypedFlatConfigEntryLike {
  readonly files?: readonly string[];
  readonly languageOptions?: {
    readonly parserOptions?: Readonly<Record<string, unknown>>;
  };
  readonly rules?: Readonly<Record<string, unknown>>;
}

/** 扁平配置数组（基础层 + 类型层）。 */
declare const config: readonly TypedFlatConfigEntryLike[];
export default config;
