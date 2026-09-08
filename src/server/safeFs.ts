// 安全文件服务（#OBS-11）：校验路径必须落在指定工作区根之下，读取并返回 Buffer。
// 复用于：
//  - appServerBase.readFs（RPC fs.read，前端 readFs 用）；
//  - httpServer route /files（前端直接 <a href> 下载 Agent 写出的文件/产物）。
// fail-closed：路径越界、文件不存在、工作区未配置一律返回 error 描述，绝不抛错穿透。
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep, join } from 'node:path';

/** 读取结果：成功返回 Buffer；失败返回带 error 描述的对象（前端可读）。 */
export type SafeReadResult =
  | { readonly ok: true; readonly buffer: Buffer; readonly size: number }
  | { readonly error: string; readonly ok: false };

/**
 * 安全读工作区内文件。
 * @param workspaceRoot 工作区根（绝对路径）；为空字符串/undefined → 一律拒绝。
 * @param rel 相对路径（允许 ./、../、绝对路径）；绝对路径会被相对化以防绕过。
 */
export function safeReadFile(workspaceRoot: string, rel: string): SafeReadResult {
  if (!workspaceRoot) {
    return { ok: false, error: '工作区未配置' };
  }
  if (typeof rel !== 'string' || rel === '') {
    return { ok: false, error: '缺少 path' };
  }
  const base = resolve(workspaceRoot);
  const target = resolve(base, rel);
  // 用 relative 判断：target === base → ''；base 内 → 'foo/bar'；越界 → '../xxx'；跨盘符 → 绝对路径。
  const relPath = relative(base, target);
  if (relPath === '..' || relPath.startsWith('..' + sep) || isAbsolute(relPath)) {
    return { ok: false, error: '路径越界工作区' };
  }
  let buf: Buffer;
  try {
    buf = readFileSync(target);
  } catch (err) {
    return { ok: false, error: '读取失败: ' + (err instanceof Error ? err.message : String(err)) };
  }
  return { ok: true, buffer: buf, size: buf.length };
}

/** join 工具（与 path.join 一致，导出仅为测试方便）。 */
export const pathJoin = join;
