/**
 * Profile 加载器（#G6，对标 codex profile_toml.rs；A2 起支持 extends 继承）。
 *
 * profile 是一份可覆盖项目默认配置的分层文件，用于「同一项目、不同运行场景」：
 * 例如 `dev`（宽松沙箱 + mock 模型）、`ci`（deny 审批 + 静默事件）、`prod`（严格沙箱）。
 * 查找顺序：项目级 ./profiles/<name>.json → 用户级 ~/.omniharness/profiles/<name>.json。
 *
 * 继承（A2）：profile 内 `extends: "<parent>"` 表示以**同目录**的 `<parent>.json` 为父，
 * 未声明字段继承父值（子覆盖父）。防环依赖「已访问」集合，环 / 过深一律 fail-closed 抛错。
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { FileConfig } from './configFile.js';
import { ConfigError } from './configError.js';

/** 继承链最大深度（防深层 / 环形 extends 造成的无限递归）。 */
const MAX_EXTENDS_DEPTH = 8;

/** Profile 文件加载器。 */
export class ProfileLoader {
  /** 在项目级与用户级 profiles 目录中查找名为 name 的 profile 文件。 */
  public find(projectDir: string, name: string): string | undefined {
    const candidates = [
      join(projectDir, 'profiles', `${name}.json`),
      join(homedir(), '.omniharness', 'profiles', `${name}.json`),
    ];
    return candidates.find((candidate) => existsSync(candidate));
  }

  /** 读取并严格校验 profile 文件（未知 key / 枚举越界 / 类型错误一律 fail-closed 抛错），解析 extends 继承链后返回合并结果。 */
  public load(filePath: string): FileConfig {
    return this.loadWithChain(filePath, new Set([resolve(filePath)]));
  }

  /**
   * 递归加载 profile 及其父链（子覆盖父）。
   * @param filePath 当前 profile 文件路径。
   * @param visited 已访问文件绝对路径集合（用于防环）。
   * @returns 合并后的配置（含本层）。
   */
  private loadWithChain(filePath: string, visited: Set<string>): FileConfig {
    const current = this.readJson(filePath);
    const parentName = current.extends;
    if (parentName === undefined) {
      return current;
    }
    if (visited.size >= MAX_EXTENDS_DEPTH) {
      throw new ConfigError(`profile 继承链过深（上限 ${MAX_EXTENDS_DEPTH} 层）: ${filePath}`);
    }
    const parentPath = join(dirname(filePath), `${parentName}.json`);
    if (!existsSync(parentPath)) {
      throw new ConfigError(
        `profile ${filePath} 继承的父 profile "${parentName}" 未找到（期望 ${parentPath}）`,
      );
    }
    const parentKey = resolve(parentPath);
    if (visited.has(parentKey)) {
      throw new ConfigError(`profile 继承存在环: ${filePath} → ${parentPath}`);
    }
    visited.add(parentKey);
    return ConfigError.mergeConfigs(this.loadWithChain(parentPath, visited), current);
  }

  /**
   * 读取单个 profile 文件并严格归一化。
   * @param filePath profile 文件路径。
   * @returns 归一化后的配置。
   * @throws ConfigError 读取失败 / JSON 非法 / 顶层非对象 / 字段校验失败。
   */
  private readJson(filePath: string): FileConfig {
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
    return ConfigError.normalizeConfig(parsed as Record<string, unknown>);
  }
}

/** 默认实例（无状态、可并发复用，调用点以 `profileLoader.xxx` 零构造复用）。 */
export const profileLoader = new ProfileLoader();
