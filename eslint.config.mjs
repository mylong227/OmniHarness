// OmniHarness ESLint 扁平配置（ESLint v9 + typescript-eslint）。
// 定位：工程化基建的「真实 bug」门禁，不抢风格（风格交给 Prettier）。
// 仅把会掩盖缺陷的规则设为 error；纯风格规则一律 off 或 warn（不阻断）。
// 不引入 js.configs.recommended —— 其 no-undef 等在 TS 下误报，TS 自有类型检查覆盖。
import tseslint from 'typescript-eslint';
import unusedImports from 'eslint-plugin-unused-imports';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'native/**',
      'web/**',
      'scripts/**',
      '.omni-worktrees/**', // harness 运行时 worktree 产物，非本仓库维护源码
      '**/*.mjs',
      '**/*.cjs',
    ],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parser: tseslint.parser,
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      'unused-imports': unusedImports,
    },
    rules: {
      'no-undef': 'off', // TS 类型检查已覆盖
      'no-unused-vars': 'off', // 由 TS 版接管，支持 ignore 前缀
      // 未用变量是历史债务+潜在死代码提示，不当阻断门禁（与 check.mjs 一致）。
      // 真 bug 才上 error；纯提示降 warn，CI 不红，但仍暴露给开发者清理。
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // 安全批量摘除未用导入（只动 import 不碰局部变量，无副作用风险）。
      // 与 @typescript-eslint/no-unused-vars 互补：本规则负责「修」，那条负责「报」局部变量。
      'unused-imports/no-unused-imports': 'warn',
      'no-var': 'error',
      'prefer-const': 'warn',
      // 以下为 TS 常见写法，非 bug，关掉以免误伤
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-this-alias': 'off',
      '@typescript-eslint/ban-types': 'off',
      'no-empty': 'off',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-control-regex': 'off',
      'no-useless-escape': 'off',
      'no-prototype-builtins': 'off',
      // 回归护栏：新测试禁止松等比较 assert.equal（与 strictEqual 在 null/undefined/数值字符串
      // 强制转换处行为不同）。存量 1533 处为 warn 不阻断；新增须用 assert.strictEqual。
      'no-restricted-syntax': [
        'warn',
        {
          selector: "CallExpression[callee.object.name='assert'][callee.property.name='equal']",
          message:
            '使用 assert.strictEqual 而非 assert.equal（松等比较在 null/undefined/类型强制处与严格比较行为不同）。',
        },
      ],
    },
  },
);
