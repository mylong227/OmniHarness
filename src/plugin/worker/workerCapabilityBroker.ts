import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PluginPermission } from '../../ports/plugin/pluginPermission.ts';
import { SafeFs } from '../../server/services/safeFs.ts';
import { WorkspaceGuard } from '../../util/workspaceGuard.ts';
import { PluginWorkerLimits } from './pluginWorkerLimits.ts';

/** 能力 broker 的调用请求。 */
export interface WorkerCapabilityCall {
  /** 能力名（如 `fs`）。 */
  readonly capability: string;
  /** 方法名（如 `read` / `write`）。 */
  readonly method: string;
  /** 参数（已由 Worker 序列化）。 */
  readonly params: unknown;
}

/**
 * 远程插件能力 broker（ADR-0012）。
 *
 * Worker 不能直接碰宿主对象；每次能力调用都到这里按插件**声明权限 + 工作区 scope**裁决。
 * 当前开放：
 *  - `fs.read`（SafeFs 双重越界校验、1 MiB 上限）；
 *  - `fs.write`（WorkspaceGuard 双重越界校验、1 MiB 上限；父目录自动创建）。
 * 其它能力（网络/进程/宿主事件）一律拒绝，避免把 broker 变成新的逃逸面。
 */
export class WorkerCapabilityBroker {
  /**
   * @param workspaceRoot 工作区根（fs 能力的唯一 scope）。
   * @param permissions 插件清单声明的权限（已由 PermissionGate 校验过白名单）。
   */
  public constructor(
    private readonly workspaceRoot: string,
    private readonly permissions: readonly PluginPermission[],
  ) {}

  /**
   * 执行一次能力调用。
   * @param call 能力/方法/参数。
   * @returns 能力结果（JSON 可序列化）。
   * @throws Error `UNAUTHORIZED_CAPABILITY` / `INVALID_FRAME`。
   */
  public async call(call: WorkerCapabilityCall): Promise<unknown> {
    if (call.capability !== 'fs') {
      throw new Error(`UNAUTHORIZED_CAPABILITY: ${call.capability}.${call.method}`);
    }
    if (call.method === 'read') {
      return this.read(call.params);
    }
    if (call.method === 'write') {
      return this.write(call.params);
    }
    throw new Error(`UNAUTHORIZED_CAPABILITY: fs.${call.method}`);
  }

  /**
   * 读取工作区文件。
   * @param params `{ path }`。
   * @returns `{ path, text }`。
   */
  private read(params: unknown): { readonly path: string; readonly text: string } {
    this.assertPermission('fs.read');
    const path = this.pathOf(params, 'fs.read');
    const result = SafeFs.safeReadFile(
      this.workspaceRoot,
      path,
      PluginWorkerLimits.CAPABILITY_READ_MAX_BYTES,
    );
    if (!result.ok) {
      throw new Error(`UNAUTHORIZED_CAPABILITY: ${result.error}`);
    }
    return { path, text: result.buffer.toString('utf8') };
  }

  /**
   * 写入工作区文件（自动创建父目录）。
   * @param params `{ path, text }`。
   * @returns `{ path, bytes }`。
   */
  private write(params: unknown): { readonly path: string; readonly bytes: number } {
    this.assertPermission('fs.write');
    const path = this.pathOf(params, 'fs.write');
    const text = (params as { readonly text?: unknown } | undefined)?.text;
    if (typeof text !== 'string') {
      throw new Error('INVALID_FRAME: fs.write 缺少 text 字符串');
    }
    if (Buffer.byteLength(text, 'utf8') > PluginWorkerLimits.CAPABILITY_WRITE_MAX_BYTES) {
      throw new Error('UNAUTHORIZED_CAPABILITY: fs.write 超过单次写入上限');
    }
    const target = new WorkspaceGuard(this.workspaceRoot).resolveSafe(path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text, 'utf8');
    return { path, bytes: Buffer.byteLength(text, 'utf8') };
  }

  /**
   * 权限断言。
   * @param permission 所需权限。
   * @returns 无返回值；未声明时抛错。
   */
  private assertPermission(permission: PluginPermission): void {
    if (!this.permissions.includes(permission)) {
      throw new Error(`UNAUTHORIZED_CAPABILITY: 插件未声明 ${permission}`);
    }
  }

  /**
   * 取合法 path 参数。
   * @param params 参数。
   * @param method 方法名（错误定位）。
   * @returns 路径字符串。
   */
  private pathOf(params: unknown, method: string): string {
    const path = (params as { readonly path?: unknown } | undefined)?.path;
    if (typeof path !== 'string' || path === '') {
      throw new Error(`INVALID_FRAME: ${method} 缺少 path`);
    }
    return path;
  }
}
