import { spawnSync } from 'node:child_process';

/**
 * Windows DPAPI 加解密封装（2026-10-21）。
 *
 * 为什么走 PowerShell 而不是原生依赖：DPAPI 的 `CryptProtectData` 没有 Node 内置绑定；
 * Windows PowerShell 的 `ConvertFrom-SecureString`（无 `-Key`）正是 DPAPI（当前用户作用域）
 * 的标准封装。输入/输出都走 stdin/stdout，**不拼命令行**，避免密钥进入进程参数/命令注入。
 *
 * 边界：仅 Windows 可用；非 Windows 返回 `false`，调用方必须保持明文/其它方案，绝不假装加密。
 */
export class Dpapi {
  /** 明文 → 密文缓存（同一密钥重复落盘时避免反复起 PowerShell）。 */
  private static readonly protectCache = new Map<string, string>();
  /** 密文 → 明文缓存（同一配置文件重复读时避免反复起 PowerShell）。 */
  private static readonly unprotectCache = new Map<string, string>();
  /** 缓存条目上限（密钥数量有限；淘汰只影响性能，不影响正确性）。 */
  private static readonly MAX_CACHE = 128;

  /**
   * 当前平台是否可用。
   * @returns Windows 上为 true。
   */
  public static available(): boolean {
    return process.platform === 'win32';
  }

  /**
   * 用当前 Windows 用户的 DPAPI 加密明文。
   * @param plaintext 明文（API Key 等）。
   * @returns DPAPI 密文（PowerShell 的十六进制串）。
   * @throws 非 Windows、PowerShell 不可用或加密失败时抛错。
   */
  public static protect(plaintext: string): string {
    const hit = Dpapi.protectCache.get(plaintext);
    if (hit !== undefined) {
      return hit;
    }
    const cipher = Dpapi.run(
      [
        '$s = [Console]::In.ReadToEnd()',
        'if ($s.Length -eq 0) { exit 2 }',
        '$sec = ConvertTo-SecureString -String $s -AsPlainText -Force',
        'ConvertFrom-SecureString -SecureString $sec',
      ].join('; '),
      plaintext,
    ).trim();
    Dpapi.remember(Dpapi.protectCache, plaintext, cipher);
    return cipher;
  }

  /**
   * 解密 DPAPI 密文（必须是同一 Windows 用户加密）。
   * @param ciphertext DPAPI 密文（十六进制串）。
   * @returns 明文。
   * @throws 非 Windows、PowerShell 不可用或解密失败时抛错。
   */
  public static unprotect(ciphertext: string): string {
    const hit = Dpapi.unprotectCache.get(ciphertext);
    if (hit !== undefined) {
      return hit;
    }
    const plain = Dpapi.run(
      [
        '$h = [Console]::In.ReadToEnd().Trim()',
        'if ($h.Length -eq 0) { exit 2 }',
        '$sec = ConvertTo-SecureString -String $h',
        '$b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)',
        'try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }',
      ].join('; '),
      ciphertext,
    );
    Dpapi.remember(Dpapi.unprotectCache, ciphertext, plain);
    return plain;
  }

  /**
   * 写入有界缓存（超限淘汰最早条目）。
   * @param cache 目标缓存。
   * @param key 键。
   * @param value 值。
   * @returns 无返回值。
   */
  private static remember(cache: Map<string, string>, key: string, value: string): void {
    if (cache.size >= Dpapi.MAX_CACHE) {
      const oldest = cache.keys().next().value;
      if (typeof oldest === 'string') {
        cache.delete(oldest);
      }
    }
    cache.set(key, value);
  }

  /**
   * 调 PowerShell 执行脚本（stdin 传入载荷）。
   * @param script PowerShell 脚本。
   * @param input 写入 stdin 的文本。
   * @returns stdout。
   * @throws 进程启动/退出码失败时抛错（带 stderr）。
   */
  private static run(script: string, input: string): string {
    if (!Dpapi.available()) {
      throw new Error('DPAPI 仅在 Windows 可用');
    }
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        input,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    if (result.error !== undefined) {
      throw new Error(`DPAPI PowerShell 启动失败: ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new Error(
        `DPAPI PowerShell 退出码 ${String(result.status)}${result.stderr ? `: ${result.stderr.trim()}` : ''}`,
      );
    }
    return result.stdout;
  }
}
