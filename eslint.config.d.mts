/**
 * 基础 ESLint 扁平配置的类型声明（G27）。
 *
 * 只声明测试用得到的形状（`files` / `languageOptions.parserOptions` / `rules`）——判据要断言的是
 * "基础层**没有**类型信息"与"类型层声明了 `project`"，不需要把 tseslint 的完整配置类型搬进来。
 */
export interface FlatConfigEntryLike {
  readonly files?: readonly string[];
  readonly languageOptions?: {
    readonly parserOptions?: Readonly<Record<string, unknown>>;
  };
  readonly rules?: Readonly<Record<string, unknown>>;
}

/** 扁平配置数组。 */
declare const config: readonly FlatConfigEntryLike[];
export default config;
