/**
 * CLI **取值型长选项**集合（`VALUE_FLAGS`）：其紧跟的下一个 token 是该旗标的取值，
 * 而不是位置参数（prompt）。
 *
 * ## 为什么单独成文件
 *
 * 原先它内联在 `cliFlagTable.ts` 里；那份文件已贴着「上帝类」的**代码行数**判据
 * （`scripts/auditStandards.mjs`：含类文件 codeLines > 500 即红）。2026-10-07 新增
 * 决策引擎三旗标时越线被增量门禁拦下，处置按本仓惯例——**抽出去，而不是放宽阈值**
 * （与 `knownFlags.ts`、`cliEnums.ts` 的拆分同一理由）。
 *
 * ## 为什么必须存在这张表
 *
 * `ArgParser.collectPositional` 用它判断「某 token 是旗标的取值还是位置参数」：漏登记会让
 * 取值被当成 prompt（实测：`--decision-engine shadow` 会把 `shadow` 当任务跑）。
 * 判据由 `tests/unit/cliFlagValueRegistry.test.ts` 机器兜底（凡消费取值的旗标必须在此登记）。
 */
export const VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--config',
  '--profile',
  '--model-adapter',
  '--base-url',
  '--api-key',
  '--model',
  '--storage-adapter',
  '--storage-dir',
  '--approval',
  '--approval-ask',
  '--sandbox',
  '--escalation',
  '--elevated-sandbox',
  '--compaction-max',
  '--spill-adapter',
  '--spill-bytes',
  '--spill-preview',
  '--defer-tools',
  '--guard-prompt-injection-mode',
  '--lsp',
  '--subagent-max-depth',
  '--subagent-concurrency',
  '--subagent-max-steps',
  '--tool',
  '--skills',
  '--workspace',
  '--output',
  '--resume',
  '--fork',
  '--replay',
  '--prompt',
  '--mcp-server',
  '--worker-dsh',
  '--plugin-profile',
  '--memory-encrypt',
  '--memory-key-file',
  '--context-window',
  '--output-format',
  '--model-router',
  '--model-router-file',
  '--turn-token-budget',
  // (P5) 成本预算三旗标（取值 → 必须登记，否则取值会被 collectPositional 并入 prompt）。
  '--cost-budget-usd',
  '--cost-budget-on-exceed',
  '--cost-budget-soft-ratio',
  '--vault-hydrate-names',
  '--vault-key-file',
  '--kv-adapter',
  '--kv-file',
  '--oidc-issuer',
  '--oidc-client-id',
  '--oidc-jwks-uri',
  // (E2 顺带修) E3 新增的 RLVR 取值旗标此前漏登记 → `collectPositional` 会把它们的取值
  // 误判为位置参数（prompt），此处补齐；并由 `cliFlagValueRegistry.test.ts` 机器兜底。
  '--rlvr-verify',
  '--rlvr-samples',
  '--rlvr-min-reward',
  '--rlvr-candidates',
  '--rlvr-min-gain',
  '--rlvr-ledger-dir',
  '--rlvr-archive-max',
  '--a2a-port',
  '--a2a-peer',
  '--a2a-transport',
  // 以下 4 项由 `cliFlagValueRegistry.test.ts` 护栏抓出（同为历史漏登记，取值会被并入 prompt）。
  '--network-allow',
  '--events',
  '--model-circuit-breaker-threshold',
  '--model-circuit-breaker-open-ms',
  // 审计 sink 三旗标（2026-10-06 第五十九轮：真实跑测发现它们**只在 serve/server 被消费**，
  // 且当时既不在 FLAG_TABLE 也不在 VALUE_FLAGS ⇒ 取值会被 `collectPositional` 当成 prompt
  // （`omniharness --audit-dir /tmp/a` 会把 `/tmp/a` 当任务跑）。它们是**取值型**旗标，必须在此登记；
  // 单跑路径上的"接受却不消费"由 `ExecCli.assertExecPathSupported` fail-closed 兜住。
  '--audit-dir',
  '--audit-file',
  '--audit-hmac-key',
  // （Laya 战略线）决策引擎的**取值型**旗标：档位与解释器路径。漏登记会让取值被
  // `collectPositional` 当成 prompt（`--decision-engine shadow` ⇒ prompt 变成 "shadow"），
  // 由 `cliFlagValueRegistry.test.ts` 机器兜底。
  '--decision-engine',
  '--decision-engine-python',
]);
