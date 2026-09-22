import type { CliArgs } from './argParser.js';

/**
 * CLI 枚举参数白名单（与 `CliArgs` 联合类型同源：`satisfies` 保证二者漂移即编译报错）。
 *
 * 此前枚举参数一律用 `as CliArgs[...]` 裸强转——拼错的值能穿过类型系统，
 * 在 `SandboxManager.build()` 落入未知 profile 分支，静默退回直通沙箱（全放行），
 * 把「参数写错」变成「沙箱失效」。安全相关枚举必须显式校验（fail-closed）。
 */
export const MODEL_ADAPTERS = [
  'mock',
  'openai',
  'anthropic',
  'responses',
  'llamacpp',
] as const satisfies readonly CliArgs['modelAdapter'][];
export const STORAGE_ADAPTERS = [
  'memory',
  'jsonl',
  'sqlite',
] as const satisfies readonly CliArgs['storageAdapter'][];
export const APPROVALS = [
  'auto',
  'deny',
  'rules',
  'guardian',
  'plan',
  'ask',
] as const satisfies readonly CliArgs['approval'][];
export const APPROVAL_ASKS = ['allow', 'deny'] as const satisfies readonly CliArgs['approvalAsk'][];
export const SANDBOX_PROFILES = [
  'passthrough',
  'policy',
  'restricted',
  'landlock',
  'seatbelt',
  'bwrap',
  'unshare',
] as const satisfies readonly CliArgs['sandbox'][];
export const ESCALATIONS = [
  'deny',
  'ask',
  'auto',
] as const satisfies readonly CliArgs['escalation'][];
export const ELEVATED_SANDBOXES = [
  'passthrough',
  'policy',
  'restricted',
] as const satisfies readonly CliArgs['elevatedSandbox'][];
export const EVENT_PORTS = ['console', 'silent'] as const satisfies readonly CliArgs['events'][];
export const SPILL_ADAPTERS = [
  'memory',
  'file',
] as const satisfies readonly CliArgs['spillAdapter'][];
/** headless 输出格式（CI 消费需要机器可读，故白名单校验而非裸强转）。 */
export const OUTPUT_FORMATS = [
  'text',
  'json',
] as const satisfies readonly CliArgs['outputFormat'][];
/** 保险库密文的底层 KV 后端（与 `vault` 子命令的 `--kv-adapter` 同一组取值）。 */
export const KV_ADAPTERS = [
  'memory',
  'json-file',
  'sqlite',
] as const satisfies readonly NonNullable<CliArgs['kvAdapter']>[];
/** (U6) A2A 传输形态白名单（枚举参数 fail-closed 校验，禁裸强转）。 */
export const A2A_TRANSPORTS = ['http', 'ws'] as const satisfies readonly NonNullable<
  CliArgs['a2aTransport']
>[];
/** (P5) 成本预算耗尽行为白名单（枚举参数 fail-closed 校验，禁裸强转）。 */
export const BUDGET_ON_EXCEED = ['fail', 'warn'] as const satisfies readonly NonNullable<
  CliArgs['costBudgetOnExceed']
>[];
/**
 * (D1) 护栏生效模式白名单。与 `EnforcementModeResolver.MODES` **同源**（`satisfies` 保证漂移即编译报错）：
 * 安全开关的取值若允许裸强转，一个拼写错误就会静默退化成「不跑」或「不生效」。
 */
export const ENFORCEMENT_MODES = [
  'off',
  'shadow',
  'enforce',
] as const satisfies readonly NonNullable<CliArgs['guardPromptInjectionMode']>[];
