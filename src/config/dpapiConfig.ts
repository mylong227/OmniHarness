import { Dpapi } from '../util/dpapi.ts';
import type { FileConfig } from '../ports/config/fileConfig.ts';

/**
 * 配置里的 Windows DPAPI 凭据读写（2026-10-21）。
 *
 * 写：`seal` 把 `apiKey` / `providerKeys` 加密成 `apiKeyDpapi` / `providerKeysDpapi` 并删明文；
 * 读：`open` 反向解密。只在 Windows 生效——非 Windows 保持明文 + 配置文件 0600，
 * 绝不假装“已加密”（读方拿不到 `apiKey` 时应明确报缺 Key，而不是静默）。
 */
export class DpapiConfig {
  /**
   * 解密配置中的 DPAPI 字段（读路径）。
   * @param config 原始配置（可能含 `apiKeyDpapi` / `providerKeysDpapi`）。
   * @returns 解密后的配置（内存里只留 `apiKey` / `providerKeys`）。
   * @throws Error 密文无法解密（换了 Windows 用户/配置被拷到别的机器）时抛出。
   */
  public static open(config: FileConfig): FileConfig {
    if (!Dpapi.available()) {
      return config;
    }
    const out: Record<string, unknown> = { ...config };
    if (typeof config.apiKeyDpapi === 'string' && config.apiKey === undefined) {
      out['apiKey'] = DpapiConfig.unprotect(config.apiKeyDpapi, 'apiKeyDpapi');
    }
    if (config.providerKeysDpapi !== undefined && config.providerKeys === undefined) {
      const keys: Record<string, string> = {};
      for (const [vendor, cipher] of Object.entries(config.providerKeysDpapi)) {
        keys[vendor] = DpapiConfig.unprotect(cipher, `providerKeysDpapi["${vendor}"]`);
      }
      out['providerKeys'] = keys;
    }
    delete out['apiKeyDpapi'];
    delete out['providerKeysDpapi'];
    return out as FileConfig;
  }

  /**
   * 加密配置中的凭据（写路径）。
   * @param config 内存配置（含明文 `apiKey` / `providerKeys`）。
   * @returns 待落盘配置（Windows 下凭据字段变为 DPAPI 密文）。
   * @throws Error DPAPI 加密失败（PowerShell 不可用等）时抛出，避免静默回退明文。
   */
  public static seal(config: FileConfig): FileConfig {
    if (!Dpapi.available()) {
      return config;
    }
    const out: Record<string, unknown> = { ...config };
    if (typeof config.apiKey === 'string' && config.apiKey !== '') {
      out['apiKeyDpapi'] = Dpapi.protect(config.apiKey);
      delete out['apiKey'];
    }
    if (config.providerKeys !== undefined) {
      const encrypted: Record<string, string> = {};
      for (const [vendor, key] of Object.entries(config.providerKeys)) {
        encrypted[vendor] = Dpapi.protect(key);
      }
      if (Object.keys(encrypted).length > 0) {
        out['providerKeysDpapi'] = encrypted;
        delete out['providerKeys'];
      }
    }
    return out as FileConfig;
  }

  /**
   * 解一条密文并把底层错误转成可行动的配置错误。
   * @param cipher 密文。
   * @param field 字段名（用于报错定位）。
   * @returns 明文。
   */
  private static unprotect(cipher: string, field: string): string {
    try {
      return Dpapi.unprotect(cipher);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `配置字段 ${field} 解密失败（${reason}）：DPAPI 密文只能由同一 Windows 用户解密；` +
          '若配置被拷到别的机器/用户，请重新填写 API Key。',
      );
    }
  }
}
