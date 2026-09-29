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
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceGuard } from '../../util/workspaceGuard.js';

/**
 * 单文件读取硬上限（字节）：64 MiB。
 *
 * `readFileSync` 整文件读进 Buffer 是 OOM 经典路径（workspaceTree 的 `fs.read`、HTTP /files
 * 下载都走这里，大文件会瞬间撑爆内存）。超过此上限即 fail-closed 拒绝读取；调用方可传更小的
 * `maxBytes` 进一步收紧（如 UI 代码视图默认 200 KiB）。
 */
const HARD_READ_CAP = 64 * 1024 * 1024;

/**
 * SafeFs —— 由本文件原顶层函数归并而来（每个方法对应一个原函数，语义与签名逐字保留）。
 */
export class SafeFs {
  /**
   * 安全读工作区内文件。
   * @param workspaceRoot 工作区根（绝对路径）；为空字符串/undefined → 一律拒绝。
   * @param rel 相对路径（允许 ./、../、绝对路径）；绝对路径会被相对化以防绕过。
   * @param maxBytes 单次读取字节上限（缺省 {@link HARD_READ_CAP}）；实际读取取
   *   `min(文件大小, maxBytes, HARD_READ_CAP)`，返回 Buffer 为该上限内字节，`size` 为文件真实大小。
   * @returns 成功返回 Buffer 与字节数；越界 / 不存在 / 未配置 / 过大返回错误描述（不抛错）。
   */
  public static safeReadFile(
    workspaceRoot: string,
    rel: string,
    maxBytes: number = HARD_READ_CAP,
  ): SafeReadResult {
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
    let stat: { size: number };
    let buf: Buffer;
    try {
      stat = statSync(target);
      // 体积上限 fail-closed：超大文件（如几百 MiB 的构建产物）绝不允许整文件读进内存。
      if (stat.size > HARD_READ_CAP) {
        return { ok: false, error: '文件过大（超过 64 MiB，拒绝整文件读入内存）' };
      }
      const limit = Math.max(0, Math.min(stat.size, maxBytes, HARD_READ_CAP));
      const fd = openSync(target, 'r');
      try {
        buf = Buffer.alloc(limit);
        readSync(fd, buf, 0, limit, 0);
      } finally {
        closeSync(fd);
      }
    } catch (err) {
      return {
        ok: false,
        error: '读取失败: ' + (err instanceof Error ? err.message : String(err)),
      };
    }
    return { ok: true, buffer: buf, size: stat.size };
  }
}

/** 读取结果：成功返回 Buffer；失败返回带 error 描述的对象（前端可读）。 */
export type SafeReadResult =
  | { readonly ok: true; readonly buffer: Buffer; readonly size: number }
  | { readonly error: string; readonly ok: false };

/** join 工具（与 path.join 一致，导出仅为测试方便）。 */
export const pathJoin = join;
