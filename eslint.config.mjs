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
      'scripts/**',
      '.omni-worktrees/**', // harness 运行时 worktree 产物，非本仓库维护源码
      // eval-data/** 与上面同理，且更必需：它是 .gitignore 掉的基准数据目录（0 个被追踪文件），
      // 里面是克隆的上游仓库与 prepare/ 下的 worktree 产物。原口径的疏漏在于——只按「本仓库源码」
      // 的直觉排除了 .omni-worktrees，却漏了同性质的 eval-data，于是 eslint . 会走进
      // astropy 自带的 vendored 第三方代码（astropy/extern/jquery/data/js/jquery-3.*.js，
      // 内含 `// eslint-disable` 注释）⇒ 报「Unused eslint-disable directive」把门禁染红。
      // 那是上游 jQuery，不是本仓库维护的源码，不该由本仓库 lint 负责 ⇒ 显式排除。
      'eval-data/**',
      // 与 .omni-worktrees 同理：.omniharness/ 是 harness 运行时产物（tbench 临时工作树、
      // 模型缓存、探针输出等），不是本仓库维护的源码。不排除它还有实害：一次跑完
      // Terminal-Bench 会在其下留下 .pytest_cache，eslint 走进去即 EPERM 把门禁染红
      // （2026-09-19 实测），与「上游 jQuery 被当成本仓源码 lint」是同一类误伤。
      '.omniharness/**',
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
      // ── 代码规范门禁（docs/CODE_STANDARD.md）──
      // 禁用 any：全库已 0 处，改 error 起长期护栏。
      '@typescript-eslint/no-explicit-any': 'error',
      // 严格明确访问权限：类成员必须显式 public/private/protected（禁止隐式 public）。
      // 可自动修复，是规范 #1 的机械护栏。
      '@typescript-eslint/explicit-member-accessibility': ['error', { accessibility: 'explicit' }],
      // 以下为 TS 常见写法，非 bug，关掉以免误伤
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
      // 回归护栏：禁止松等比较 assert.equal（与 strictEqual 在 null/undefined/数值字符串
      // 强制转换处行为不同）。存量已在 2026-09-16 清零（原 104 处，含 7 个测试文件），
      // 且 `npm run lint` 已收紧为 `--max-warnings=0`，故此处规则一触发即阻断提交。
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
  {
    // TODO(parallel-session): 这组文件正被 Agent-Loop 并行会话占用（未提交改动）。
    // 暂缓 explicit-member-accessibility 门禁，避免与其改动冲突；待其收口后删除本覆盖块，
    // 使热区文件同样纳入规范 #1。no-explicit-any 无需豁免（全库 0 处）。
    files: [
      'src/core/stepRunner.ts',
      'src/core/turnRunner.ts',
      'src/ports/toolInputSink.ts',
      'src/adapters/live/**',
    ],
    rules: {
      '@typescript-eslint/explicit-member-accessibility': 'off',
    },
  },
);
