// 安全文件服务（#OBS-11）：校验路径必须落在指定工作区根之下，读取并返回 Buffer。
// 复用于：
//  - workspaceTree.readFile（RPC fs.read，前端 readFs 用）；
//  - httpServer route /files（前端直接 <a href> 下载 Agent 写出的文件/产物）。
// fail-closed：路径越界、文件不存在、工作区未配置一律返回 error 描述，绝不抛错穿透。
//
// 2026-09-22 修：**符号链接 / Windows junction 逃逸**。原实现只做词法校验
// （`resolve` + `relative`），于是「工作区内一个指向外部的 junction」可以被读到宿主任意文件
// （实测：junction → 外部目录，`safeReadFile` 返回 ok:true 与外部文件内容，而同路径
// `WorkspaceGuard.isInside` 为 false ⇒ 属漏用既有守卫，不是策略差异）。
// 现改为复用 {@link WorkspaceGuard.resolveSafe}：词法判定 + realpath 判定两层一致。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceGuard } from '../../util/workspaceGuard.js';

/** 读取结果：成功返回 Buffer；失败返回带 error 描述的对象（前端可读）。 */
export type SafeReadResult =
  | { readonly ok: true; readonly buffer: Buffer; readonly size: number }
  | { readonly error: string; readonly ok: false };

/**
 * 安全读工作区内文件。
 * @param workspaceRoot 工作区根（绝对路径）；为空字符串/undefined → 一律拒绝。
 * @param rel 相对路径（允许 ./、../、绝对路径）；绝对路径会被相对化以防绕过。
 * @returns 成功返回 Buffer 与字节数；越界 / 不存在 / 未配置返回错误描述（不抛错）。
 */
export function safeReadFile(workspaceRoot: string, rel: string): SafeReadResult {
  if (!workspaceRoot) {
    return { ok: false, error: '工作区未配置' };
  }
  if (typeof rel !== 'string' || rel === '') {
    return { ok: false, error: '缺少 path' };
  }
  // 词法越界 + 符号链接/junction 逃逸双重判定，全部复用 WorkspaceGuard（单一实现来源）。
  // 两类失败共用同一对外文案，保持既有前端契约不变。
  let target: string;
  try {
    target = new WorkspaceGuard(workspaceRoot).resolveSafe(rel);
  } catch {
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
