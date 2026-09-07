# 差距一次性抹平 · 结案报告（2026-09-02）

> 标的：`D:\deepseek\omniharness`（自研 TS+Rust Agent Harness）对标成熟 harness（Codex CLI / Claude Code）的剩余差距。
> 基线盘点见 `2026-09-02.md`「续二十三 · 差距重审」。
> 原则：所有结论基于**真实跑通的命令**，不估、不假绿；无法在本机验证的边界如实标注。

## 一、缺口 → 落地 → 验证 总表

| 等级 | 缺口                                        | 落地文件                                                                                                                                                                                     | 验证                                                                                       |
| ---- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| P0   | 工程化基建缺 lint/format/hook/覆盖率门禁    | `eslint.config.mjs` / `.prettierrc.json` / `.prettierignore` / `scripts/coverageGate.mjs` / `scripts/git-hooks/pre-commit` / `scripts/install-hooks.mjs` / `ci.yml` / `package.json` scripts | `lint` 0 error；`coverage:check` 100%≥80%；`check.mjs` 零违规                              |
| P1   | SSRF：外联默认开放、私有网段可被打          | `src/adapters/sandbox/networkEgress.ts`                                                                                                                                                      | 测试 `SSRF 私有/链路本地地址无论白名单一律拒绝` 通过（含 `169.254.169.254`、IPv6 `[::1]`） |
| P1   | 提权复核沙箱默认 `passthrough`（fail-open） | `src/cli/args.ts` / `src/config/{configLayer,configFile,omniharnessConfig}.ts` / `src/core/toolGate.ts`                                                                                      | `CliDefaults.elevatedSandbox==='policy'`、`ConfigFactory` 回落 `policy` 断言通过           |
| P2   | 错误码散落、无集中 catalog                  | `src/errors.ts` + 迁移 5 个错误类                                                                                                                                                            | `errors.test.ts` 验证 `code`+类名                                                          |
| P2   | 提示注入无缓解基线                          | `src/security/promptInjection.ts`                                                                                                                                                            | `promptInjection.test.ts` 4 用例通过                                                       |
| P2   | eval 仅 2 任务、缺混沌/故障注入             | `evals/smoke.json`（2→6）/ `tests/unit/sandboxRobustness.test.ts`                                                                                                                            | 全量 612 用例 0 失败                                                                       |

## 二、关键修复（本轮自测挖出的真 bug）

1. **IPv6 SSRF 漏防**：`new URL('http://[::1]/').hostname` 返回带方括号的 `[::1]`，原私有网段正则只认裸 `::1` → IPv6 环回被放行。修复：`hostOf` 规范剥离方括号，下游 `isPrivateHost`/`isAllowed` 统一对齐。
2. **cliEnumValidation 自相矛盾**：该测试用 `'restricted'` 当「非法值」验抛错，但本轮把 `'restricted'` 加进 `ELEVATED_SANDBOXES` 当合法提权后端 → 测试 fail-open 复活、自己打挂自己。修复：测试改用真不在枚举内的值 `passthru`，保留「非法值必须抛错」本意。

> 修复前全量：`# fail 2`；修复后：`# tests 612 / # pass 606 / # fail 0 / # skipped 6`。

## 三、工程化闸门（最终全部绿）

```
npm run check          ✅ 扫描 245 个 TS 文件，零违规（铁律：零运行时依赖 / 禁第三方裸导入 / camelCase）
npm run lint           ✅ 0 errors / 386 warnings（未用变量降 warn，不阻断 CI，仍暴露死代码）
npm test               ✅ # tests 612 / # pass 606 / # fail 0 / # skipped 6
npm run coverage:check ✅ 行覆盖率 100% ≥ 阈值 80%，达标
pre-commit 钩子        ✅ core.hooksPath 已指向 scripts/git-hooks（铁律自检 + ESLint + Prettier 增量格式化）
```

覆盖率门禁阈值默认 80%（env `MIN_LINE_COVERAGE` 或 `coverage:check <n>` 可覆盖）。当前测量值 100% 为 `dist/**` 聚合口径，设 80% 是为了给未来留出非脆性缓冲——既不至于一次小跌就红，也能挡住断崖式缩水。

## 四、CI 接线

- `gate` job：`check` → `typecheck` → `build` → `lint`（ESLint 仅 error 阻断）。
- `test` job：`coverage:check`（构建 + 全量测试 + 内置覆盖率 + 行覆盖率阈值门禁，零依赖，不引入第三方上报）。

## 五、诚实边界（无法在本机验证，不写未验证代码）

- **OS 级沙箱后端**（landlock/seatbelt/bwrap）：仅 `restricted` 的 TS 策略沙箱 + Windows RestrictedToken（Rust 内核）真实可跑；landlock/seatbelt/bwrap 为 fail-closed 占位，需真机内核运行时验证。
- **原生内核 `.node` 未构建**：`--native` 路径的 OS 隔离在 `.node` 就绪时才真正下沉；CI/本机未编 `.node`，相关用例自动 skip（非假绿）。

## 六、未决 / 后续可选

- 386 个 `no-unused-vars` warning 是历史死代码提示，已降 warn 不阻断；若要做「真成熟」可开一轮清理（删未用 import），但属历史债务、非本轮对标缺口。
- 改动均未提交（用户未要求 commit）；建议评审后 `git commit`。
