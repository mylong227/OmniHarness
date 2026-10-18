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
      // 构建「原子换入」的备份/中间目录（`scripts/buildDist.mjs`）：换入成功后会尽力删 `dist.old`，
      // 但目录被占用时删不掉（2026-10-13 实测 25MB / 4874 文件，被安全删除钩子以
      // SAFE_DELETE_BULK_CONFIRM_REQUIRED 拦下）。而 `'dist/**'` **不匹配** `dist.old/**`
      // ⇒ 里面的 `.d.ts` 被当本仓源码 lint：实测 **2733 条** `explicit-member-accessibility`
      // error，直接把 pre-commit 打红、提交全被挡住。构建产物不是本仓维护源码，与下方
      // `eval-data/**`（上游 vendored jQuery）同一条理由。
      'dist.old/**',
      'dist.next/**',
      // Web 端构建产物（`npm run web:build` → `web/dist/assets/*.js`）。
      // 2026-10-18 实测：KaTeX 拆成异步 chunk 后，那个 chunk 里带着上游的 `eslint-disable`
      // 注释（引用了本仓没装的规则）⇒ `eslint .` 报「Definition for rule ... was not found」
      // 三条，pre-commit 直接红。构建产物不是本仓维护的源码，和 `dist/**` 同一条理由。
      'web/dist/**',
      // 真机截图/探针产物（`web/archive/`，`.gitignore` 已忽略）：不是源码。
      'web/archive/**',
      'node_modules/**',
      'coverage/**',
      'native/**',
      'scripts/**',
      '.omni-worktrees/**', // harness 运行时 worktree 产物，非本仓库维护源码
      // 保留 `eval-data/**` 排除：该目录（克隆的上游仓库 + prepare/ 下的 worktree 产物）已于
      // 2026-10-03 随跑分/评测子系统**整体删除**，此处按「防御性保留」留一行——一旦有人用旧
      // 工具链重新生成同名目录，`eslint .` 不会走进去 lint 上游 vendored 代码
      // （历史实害：astropy 自带的 jQuery 内含 `// eslint-disable` ⇒ 报 Unused directive 染红门禁）。
      'eval-data/**',
      // 与 .omni-worktrees 同理：.omniharness/ 是 harness 运行时产物（tbench 临时工作树、
      // 模型缓存、探针输出等），不是本仓库维护的源码。不排除它还有实害：一次跑完
      // Terminal-Bench 会在其下留下 .pytest_cache，eslint 走进去即 EPERM 把门禁染红
      // （2026-09-19 实测），与「上游 jQuery 被当成本仓源码 lint」是同一类误伤。
      '.omniharness/**',
      // 与 .omniharness 同理：.tmpcheck/ 是临时探针与提交信息草稿目录（未被 .gitignore
      // 追踪过也不该入库），里面的 bad.js 之类故意写坏的探针文件会以 Parsing error
      // 把 lint 门禁染红（2026-10-02 pre-commit 实测）。不是本仓库维护的源码 ⇒ 显式排除。
      '.tmpcheck/**',
      // `.tmp/` 同源问题（2026-10-18 实测）：探针/打包分析脚本会在这里落 `esb.js`（esbuild 产出的
      // 2.9 MB 开发包，内含上游 `eslint-disable` 注释）⇒ 三条「Rule definition not found」把门禁打红。
      // 该目录已在 `.gitignore` 里，但不是源码，必须在这里也排除（ESLint 不读 gitignore）。
      '.tmp/**',
      '**/*.mjs',
      '**/*.cjs',
      // vendored 运行时物料与构建产物（2026-10-09 实测补入）：
      // `third-party/**` 是本机 Python venv（laya/torch/transformers 等），`target/**` 是 Rust 构建产物
      // （`.gitignore:53` 已忽略）。两者都不是本仓维护的源码，但此前**未**列入 ignores ⇒
      // `eslint .` 会进去 walk 4932 个目录、最终只命中 **2** 个 `.js`（都在 site-packages 内、0 条 message），
      // 而 `eslint .` 单跑实测 **39.8s**，是 fast 层（10 条门禁合计 ~60s）里最大的一笔。
      // 与上面 `eval-data/**`（上游 vendored jQuery 被当本仓源码 lint）是同一条理由，属同一类误伤。
      // 判据：加这两条前后，eslint 的**被检查文件集**除这 2 个 vendored 文件外完全一致（实测 1781 → 1779）。
      'third-party/**',
      'target/**',
    ],
  },
  {
    // `.tsx` 必须一起纳入（2026-10-17 修）：此前只写了 `**/*.ts`，于是 **60 个组件文件
    //（约 116 KB）从未被 lint 过**——ESLint 对它们的原话是
    // `File ignored because no matching configuration was supplied`。
    // 后果不是"少几条提示"，而是整整一层代码（UI 组件）在规范门禁之外：
    // 未使用导入、未使用状态、遗留别名都无人发现。首次纳入时暴露出 12 条真实死代码，
    // 已当场清干净（0 error / 0 warning），此后任何新增都会立刻被 pre-commit 挡住。
    files: ['**/*.ts', '**/*.tsx'],
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
