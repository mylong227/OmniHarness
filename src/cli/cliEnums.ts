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
