/**
 * `lspWorkspaceSymbolFixture.mjs` 的类型声明。
 *
 * 该 fixture 是 `.mjs`（供 mock LSP 服务器与单测共享同一份语料），而本仓 tsconfig 不开
 * `allowJs`。声明必须是 `.d.mts`（与 `.mjs` 同族）——写成 `.d.ts` 在 NodeNext 解析下
 * **不匹配 `.mjs` 导入**，TS 仍会报 TS7016「implicitly has an any type」。
 */
/** 假仓库根（真实存在的临时目录）。 */
export declare const REPO_ROOT: string;

/** 测试侧断言用的期望路径。 */
export declare const WORKSPACE_SYMBOL_PATHS: {
  readonly repoRoot: string;
  readonly srcDir: string;
  readonly demoFile: string;
  readonly utilFile: string;
};

/** `workspace/symbol` 的固定返回语料（形状交给归一化器判定，故按 unknown 处理）。 */
export declare const WORKSPACE_SYMBOL_FIXTURE: readonly unknown[];
