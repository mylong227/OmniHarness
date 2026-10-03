// OmniHarness ESLint **类型感知层**配置（G27/TS3，2026-10-03 第十六轮）。
//
// ## 为什么是「分层」而不是「换引擎」
//
// 生态里已有的规则继续交给 eslint；自研脚本（`check.mjs` / `architectureGate.mjs` /
// `auditStandards.mjs` / `auditConfigWiring.mjs` / `docLinkCheck.mjs` …）只管**不需要类型**的部分
// ——它们跑得快、无类型信息也能判。**需要类型**的规则（"这个 Promise 没人 await"这类只有类型系统
// 才看得见的东西）则单独成层，见本文件。
//
// ## 两层口径
//
// | 层 | 内容 | 何时跑 | 预算（本机实测） |
// | --- | --- | --- | --- |
// | 快层 | `eslint .`（`eslint.config.mjs`，**不含** `parserOptions.project`）+ 全部自研脚本 | 每次提交（pre-commit） | `eslint .` < 65 s |
// | 类型层 | 本文件：`tsc --noEmit` + `eslint src --config eslint.typed.config.mjs` | 轮次/CI 全量核验（`npm run gate:typed`） | 两者之和 ≤ 45 s |
//
// 预算由 `scripts/gateBudget.mjs` **实测并断言**（不是文档里的口号）：超预算即红，
// 迫使"再加一条 typed 规则"这件事必须先解决耗时，而不是慢慢把门禁拖成没人愿意跑的东西。
//
// ## 为什么只挑这三条规则
//
// 候选规则实测（2026-10-03，`src/**`）：`no-floating-promises` / `await-thenable` /
// `no-misused-promises` **零违规**（可直接当护栏）；而 `require-await`(117)、
// `no-unnecessary-type-assertion`(78)、`no-unsafe-assignment`(16) 存量较大，
// 属"先清存量再上闸门"的活，**不在本轮范围**（如实登记，不假装已覆盖）。
import base from './eslint.config.mjs';
import tseslint from 'typescript-eslint';

export default tseslint.config(...base, {
  files: ['src/**/*.ts'],
  languageOptions: {
    parserOptions: {
      // 用 `project`（显式 tsconfig）而非 `projectService`：本机实测 26.4 s vs 28.3 s，
      // 且显式工程边界更贴合"只覆盖 src/**"的口径。
      project: ['./tsconfig.json'],
      tsconfigRootDir: import.meta.dirname,
    },
  },
  rules: {
    // 悬空 Promise：异步调用没 await / 没 .catch ⇒ 失败被静默吞掉（本仓最怕的静默失败形态）。
    '@typescript-eslint/no-floating-promises': 'error',
    // 对非 Promise 值 await：几乎总是写错了对象（await 了一个普通值而真正的异步没等到）。
    '@typescript-eslint/await-thenable': 'error',
    // Promise 用在了不该用的位置：条件判断、`||`/`&&` 左值、回调签名不匹配等。
    '@typescript-eslint/no-misused-promises': 'error',
  },
});
