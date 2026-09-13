import { pathToFileURL, fileURLToPath } from 'node:url';

/**
 * @beta
 * 文件系统路径 → file:// URI（LSP 协议要求的文档标识）。
 */
export function fileToUri(filePath: string): string {
  return pathToFileURL(filePath).href;
}

/**
 * @beta
 * file:// URI → 文件系统路径；非 file:// 原样返回（便于测试用假 URI）。
 */
export function uriToFile(uri: string): string {
  if (uri.startsWith('file://')) {
    return fileURLToPath(uri);
  }
  return uri;
}
