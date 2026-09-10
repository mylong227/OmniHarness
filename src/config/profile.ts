/**
 * Profile 加载器（#G6，对标 codex profile_toml.rs）。
 *
 * profile 是一份可覆盖项目默认配置的分层文件，用于「同一项目、不同运行场景」：
 * 例如 `dev`（宽松沙箱 + mock 模型）、`ci`（deny 审批 + 静默事件）、`prod`（严格沙箱）。
 * 查找顺序：项目级 ./profiles/<name>.json → 用户级 ~/.omniharness/profiles/<name>.json。
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { FileConfig } from './configFile.js';
import { ConfigError, normalizeConfig } from './configLayer.js';

/** Profile 文件加载器。 */
export class ProfileLoader {
  /** 在项目级与用户级 profiles 目录中查找名为 name 的 profile 文件。 */
  public static find(projectDir: string, name: string): string | undefined {
    const candidates = [
      join(projectDir, 'profiles', `${name}.json`),
      join(homedir(), '.omniharness', 'profiles', `${name}.json`),
    ];
    return candidates.find((candidate) => existsSync(candidate));
  }

  /** 读取并严格校验 profile 文件（未知 key / 枚举越界 / 类型错误一律 fail-closed 抛错）。 */
  public static load(filePath: string): FileConfig {
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch (err) {
      throw new ConfigError(`无法读取 profile 文件 ${filePath}: ${(err as Error).message}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new ConfigError(`profile 文件 ${filePath} 不是合法 JSON: ${(err as Error).message}`);
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw new ConfigError(`profile 文件 ${filePath} 顶层应为对象`);
    }
    return normalizeConfig(parsed as Record<string, unknown>);
  }
}
