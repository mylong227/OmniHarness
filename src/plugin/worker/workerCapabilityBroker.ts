import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
    private readonly storeDir: string = join(workspaceRoot, '.omniharness', 'plugin-store'),
  ) {}

  /**
   * 执行一次能力调用。
   * @param call 能力/方法/参数。
   * @returns 能力结果（JSON 可序列化）。
   * @throws Error `UNAUTHORIZED_CAPABILITY` / `INVALID_FRAME`。
   */
  public async call(call: WorkerCapabilityCall): Promise<unknown> {
    if (call.capability === 'store') {
      return this.store(call.method, call.params);
    }
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
   * 插件键值存储（每个插件独立目录；key 白名单，防路径穿越）。
   * @param method get / set / delete / list。
   * @param params `{ key, value? }`。
   * @returns 读取值 / 写入确认 / 删除确认 / key 列表。
   */
  private store(method: string, params: unknown): unknown {
    if (method === 'get') {
      this.assertPermission('store.read');
      const key = this.storeKey(params, method);
      const file = join(this.storeDir, `${key}.json`);
      if (!existsSync(file)) return null;
      return JSON.parse(readFileSync(file, 'utf8')) as unknown;
    }
    if (method === 'list') {
      this.assertPermission('store.read');
      if (!existsSync(this.storeDir)) return [];
      return readdirSync(this.storeDir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.slice(0, -'.json'.length))
        .sort();
    }
    if (method === 'set') {
      this.assertPermission('store.write');
      const key = this.storeKey(params, method);
      const value = (params as { readonly value?: unknown } | undefined)?.value;
      if (value === undefined) {
        throw new Error('INVALID_FRAME: store.set 缺少 value');
      }
      const text = JSON.stringify(value);
      if (Buffer.byteLength(text, 'utf8') > PluginWorkerLimits.CAPABILITY_STORE_MAX_BYTES) {
        throw new Error('UNAUTHORIZED_CAPABILITY: store.set 超过单值上限');
      }
      mkdirSync(this.storeDir, { recursive: true });
      writeFileSync(join(this.storeDir, `${key}.json`), text, 'utf8');
      return { key, bytes: Buffer.byteLength(text, 'utf8') };
    }
    if (method === 'delete') {
      this.assertPermission('store.write');
      const key = this.storeKey(params, method);
      rmSync(join(this.storeDir, `${key}.json`), { force: true });
      return { key, deleted: true };
    }
    throw new Error(`UNAUTHORIZED_CAPABILITY: store.${method}`);
  }

  /**
   * 校验 store key（仅字母数字/下划线/点/连字符，长度 1–128）。
   * @param params 参数。
   * @param method 方法名（错误定位）。
   * @returns 合法 key。
   */
  private storeKey(params: unknown, method: string): string {
    const key = (params as { readonly key?: unknown } | undefined)?.key;
    if (typeof key !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(key)) {
      throw new Error(`INVALID_FRAME: ${method} 的 key 不合法`);
    }
    return key;
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
