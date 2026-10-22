import { dirname } from 'node:path';
import type { SandboxPort } from '../../ports/runtime/sandbox.ts';

/** Worker 进程启动参数。 */
export interface WorkerSpawnSpec {
  /** 可执行文件。 */
  readonly bin: string;
  /** argv。 */
  readonly args: string[];
  /** 环境变量。 */
  readonly env: NodeJS.ProcessEnv;
  /** Windows 上是否原样传 argv（仅 cmd 包装路径需要）。 */
  readonly verbatim: boolean;
}

/** Worker 启动参数构造选项。 */
export interface WorkerSpawnSpecOptions {
  /** 插件入口绝对路径。 */
  readonly entryPath: string;
  /** 插件名。 */
  readonly pluginName: string;
  /** Worker 入口。 */
  readonly workerEntry: string;
  /** 会话标识。 */
  readonly session: string;
  /** OS 沙箱（可选）。 */
  readonly sandbox?: SandboxPort;
}

/**
 * 构造 Worker 的 spawn 参数（ADR-0012）。
 *
 * 单独成类的原因：沙箱 argv 包装、Node 权限参数、最小环境三件事叠加后会让
 * `spawnWorker` 超过函数体上限；这里只做纯参数构造，便于单测与审阅。
 */
export class WorkerSpawnSpecBuilder {
  /**
   * 构造参数。
   * @param options 构造选项。
   * @returns bin/args/env/verbatim。
   */
  public static build(options: WorkerSpawnSpecOptions): WorkerSpawnSpec {
    const permissionArgs =
      process.env['OMNI_PLUGIN_WORKER_PERMISSION'] === '0'
        ? []
        : [
            '--experimental-permission',
            `--allow-fs-read=${dirname(options.entryPath)}`,
            `--allow-fs-read=${options.workerEntry}`,
          ];
    const args = [...permissionArgs, options.workerEntry, '--plugin-worker'];
    const env: NodeJS.ProcessEnv = {
      OMNI_PLUGIN_WORKER_SESSION: options.session,
      OMNI_PLUGIN_ENTRY: options.entryPath,
      OMNI_PLUGIN_NAME: options.pluginName,
      SYSTEMROOT: process.env['SystemRoot'] ?? '',
      TEMP: process.env['TEMP'] ?? '',
      TMP: process.env['TMP'] ?? '',
      PATH: process.env['PATH'] ?? '',
    };
    const wrapped = WorkerSpawnSpecBuilder.wrap(options, args);
    return { ...wrapped, env, verbatim: wrapped.verbatim };
  }

  /**
   * 应用沙箱包装（优先无 shell 的 wrapArgv）。
   * @param options 构造选项。
   * @param args 原始 Worker argv。
   * @returns bin/args/verbatim。
   */
  private static wrap(
    options: WorkerSpawnSpecOptions,
    args: readonly string[],
  ): { bin: string; args: string[]; verbatim: boolean } {
    const sandbox = options.sandbox;
    if (sandbox?.wrapArgv !== undefined) {
      const wrapped = sandbox.wrapArgv([process.execPath, ...args], dirname(options.entryPath));
      return { bin: wrapped.bin, args: wrapped.args, verbatim: false };
    }
    if (sandbox?.wrapCommand !== undefined) {
      const quote = (value: string): string => `"${value.replace(/"/gu, '""')}"`;
      const inner = [process.execPath, ...args].map(quote).join(' ');
      const command = sandbox.wrapCommand(inner, dirname(options.entryPath));
      if (process.platform === 'win32') {
        return {
          bin: process.env['ComSpec'] ?? 'cmd.exe',
          args: ['/d', '/s', '/c', command],
          verbatim: true,
        };
      }
      return { bin: '/bin/sh', args: ['-c', command], verbatim: false };
    }
    return { bin: process.execPath, args: [...args], verbatim: false };
  }
}
