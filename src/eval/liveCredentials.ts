/**
 * 用户级凭据读取（evals / benchmark 脚本的环境变量兜底层）。
 *
 * 凭据分层纪律（2026-09-25 收口）：真实密钥**只**存放于用户级配置
 * `~/.omniharness/omniharness.json`（在仓库树之外，任何发布物不含个人数据；
 * 项目级 `omniharness.json` 只放非个人配置，模板见 `omniharness.json.example`）。
 * eval/bench 脚本在环境变量缺失时经此函数回退读取用户级配置，
 * 以替代曾存放于仓库树内的 `.env`（该形态已随本次收口废除）。
 *
 * fail-closed：文件缺失 / JSON 非法 / 字段缺型一律返回 `undefined`，
 * 绝不抛错打断脚本调用方（脚本各自已有「缺凭据即明确退出」的口径）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 用户级配置的固定位置（与 `ConfigFile.loadLayered` 的用户层同源）。 */
export function userConfigPath(homedirOverride?: string | undefined): string {
  return join(homedirOverride ?? homedir(), '.omniharness', 'omniharness.json');
}

/**
 * 从用户级配置读取指定 provider 的密钥（缺省 `deepseek`）。
 *
 * @param opts.userConfigPath 覆盖用户级配置路径（测试注入用；缺省 `~/.omniharness/omniharness.json`）
 * @param opts.provider provider 名（对应配置内 `providerKeys` 的键；缺省 `deepseek`）
 * @returns 密钥字符串；用户级配置缺失 / 非法 / 无该 provider 或值非非空字符串时返回 `undefined`
 */
export function readUserProviderKey(
  opts: {
    readonly userConfigPath?: string | undefined;
    readonly provider?: string | undefined;
  } = {},
): string | undefined {
  const path = opts.userConfigPath ?? userConfigPath();
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) {
      return undefined;
    }
    const keys: unknown = (parsed as { providerKeys?: unknown }).providerKeys;
    if (typeof keys !== 'object' || keys === null) {
      return undefined;
    }
    const value: unknown = (keys as Record<string, unknown>)[opts.provider ?? 'deepseek'];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}
