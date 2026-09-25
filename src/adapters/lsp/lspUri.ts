import { pathToFileURL, fileURLToPath } from 'node:url';

/**
 * LspUri —— 由本文件原顶层函数归并而来（每个方法对应一个原函数，语义与签名逐字保留）。
 */
export class LspUri {
  /**
   * @beta
   * 文件系统路径 → file:// URI（LSP 协议要求的文档标识）。
   */
  public static fileToUri(filePath: string): string {
    return pathToFileURL(filePath).href;
  }

  /**
   * @beta
   * file:// URI → 文件系统路径；非 file:// 原样返回（便于测试用假 URI）。
   *
   * 解析失败也**原样返回**，绝不抛错：URI 由服务器给出，它可能给出平台不兼容的形态
   * （典型：Windows 上收到缺盘符的 `file:///repo/a.ts`，`fileURLToPath` 会抛
   * `ERR_INVALID_FILE_URL_PATH`）。归一化层对服务器的畸形输入必须**降级而不是崩**——
   * 一条坏 URI 不该让整次符号查询（乃至整个会话）失败。
   */
  public static uriToFile(uri: string): string {
    if (!uri.startsWith('file://')) {
      return uri;
    }
    try {
      return fileURLToPath(uri);
    } catch {
      return uri;
    }
  }
}
