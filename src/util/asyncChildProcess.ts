/**
 * 异步子进程工具 —— 取代同步 `spawnSync` / `execFileSync` / `execSync`。
 *
 * 背景：本 agent 运行时的 node（Electron-as-node）沙箱**硬拦截同步 child_process**
 * （`spawnSync` / `execFileSync` / `execSync` 一律返回 `EBUSY`），但**异步 `spawn` 放行**。
 * CI 与本地终端无此限制，故这里统一用异步 `spawn` 实现等价语义，让源码在本运行时也可正常起子进程。
 *
 * 与 `tests/helpers/childProcess.ts` 保持同一套返回值约定，便于测试与源码对齐。
 */

import { spawn, type SpawnOptions } from 'node:child_process';

/** 进程运行选项：透传 `SpawnOptions`，并允许 `encoding`（控制 stdout/stderr 合并为字符串还是 Buffer）。 */
export interface RunProcessOptions extends SpawnOptions {
  /** 输出编码；传 `'utf8'` 时 stdout/stderr 为字符串，否则为 Buffer。 */
  readonly encoding?: BufferEncoding | 'buffer';
  /** 喂给子进程 stdin 的内容（`spawn` 接受，类型层补丁）。 */
  readonly input?: string | Buffer | NodeJS.TypedArray;
  /**
   * stdout / stderr 各自的最大字节数（默认 10 MiB，与 `spawnSync` 的 maxBuffer 语义对齐）。
   * 超限即强杀子进程并返回带 `error` 的结果（避免无界输出撑爆堆）。
   */
  readonly maxBufferBytes?: number;
}

/** 默认输出上限（每路）：10 MiB。 */
const DEFAULT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/** 与 `spawnSync` 返回结构对齐的结果（Buffer 形态）。 */
export interface SpawnSyncLikeResult {
  /** 退出码；进程未启动（如 ENOENT）时为 `null`。 */
  readonly status: number | null;
  /** 终止信号；无则为 `null`。 */
  readonly signal: NodeJS.Signals | null;
  /** 标准输出（依 `encoding`）。 */
  readonly stdout: string | Buffer;
  /** 标准错误（同上）。 */
  readonly stderr: string | Buffer;
  /** 启动失败时的错误（如 ENOENT）；正常退出时为 `undefined`。 */
  readonly error?: Error;
}

/** 与 `spawnSync` 返回结构对齐的结果（`encoding:'utf8'` 形态，stdout/stderr 为字符串）。 */
export interface SpawnSyncLikeUtf8Result {
  /** 退出码；进程未启动（如 ENOENT）时为 `null`。 */
  readonly status: number | null;
  /** 终止信号；无则为 `null`。 */
  readonly signal: NodeJS.Signals | null;
  /** 标准输出（字符串）。 */
  readonly stdout: string;
  /** 标准错误（字符串）。 */
  readonly stderr: string;
  /** 启动失败时的错误（如 ENOENT）；正常退出时为 `undefined`。 */
  readonly error?: Error;
}

/**
 * 异步等价 `spawnSync`：用 `spawn` 起进程，收集 stdout/stderr，监听 `close` / `error`。
 * 不随退出码非 0 抛错（与 `spawnSync` 一致），由调用方读 `status` 判断。
 */
export class AsyncChildProcess {
  /**
   * 异步等价 `spawnSync`（UTF-8 形态）：stdout/stderr 为字符串。
   * @param file 可执行文件（或命令）。
   * @param args 参数列表。
   * @param options 透传给 `spawn` 的 `SpawnOptions`（已强制 `windowsHide:true`）。
   * @returns 进程结果，结构对齐 `spawnSync` 返回值。
   */
  public static spawnSyncAsync(
    file: string,
    args: ReadonlyArray<string>,
    options: RunProcessOptions & { readonly encoding: 'utf8' },
  ): Promise<SpawnSyncLikeUtf8Result>;
  /**
   * 异步等价 `spawnSync`（Buffer 形态）。
   * @param file 可执行文件（或命令）。
   * @param args 参数列表。
   * @param options 透传给 `spawn` 的 `SpawnOptions`。
   * @returns 进程结果，结构对齐 `spawnSync` 返回值。
   */
  public static spawnSyncAsync(
    file: string,
    args?: ReadonlyArray<string>,
    options?: RunProcessOptions,
  ): Promise<SpawnSyncLikeResult>;
  /**
   * 异步等价 `spawnSync` 的实现（见上方重载签名决定返回形态）。
   * @param file 可执行文件（或命令）。
   * @param args 参数列表（缺省空数组）。
   * @param options 透传给 `spawn` 的 `SpawnOptions`（已强制 `windowsHide:true`）。
   * @returns 进程结果，结构对齐 `spawnSync` 返回值（UTF-8 形态为字符串，否则为 Buffer）。
   */
  public static spawnSyncAsync(
    file: string,
    args: ReadonlyArray<string> = [],
    options: RunProcessOptions = {},
  ): Promise<SpawnSyncLikeResult> {
    return new Promise<SpawnSyncLikeResult>((resolve) => {
      const useUtf8 = options.encoding === 'utf8';
      const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
      const proc = spawn(file, [...args], { ...options, windowsHide: true });
      const out: Array<Buffer | string> = [];
      const err: Array<Buffer | string> = [];
      let outBytes = 0;
      let errBytes = 0;
      let settled = false;
      /** 只交付第一个终态（`error` 与 `close` 可能先后到达）。 */
      const finish = (result: SpawnSyncLikeResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      /** 输出超限：强杀并交付可归因错误（保留已收集的部分输出）。 */
      const overflow = (stream: 'stdout' | 'stderr'): void => {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* 进程可能已退出 */
        }
        finish({
          status: null,
          signal: null,
          stdout: AsyncChildProcess.mergeChunks(out, useUtf8),
          stderr: AsyncChildProcess.mergeChunks(err, useUtf8),
          error: new Error(`${stream} 超过 maxBufferBytes=${String(maxBufferBytes)}`),
        });
      };
      proc.stdout?.on('data', (chunk: Buffer | string) => {
        out.push(chunk);
        outBytes += Buffer.byteLength(chunk);
        if (outBytes > maxBufferBytes) overflow('stdout');
      });
      proc.stderr?.on('data', (chunk: Buffer | string) => {
        err.push(chunk);
        errBytes += Buffer.byteLength(chunk);
        if (errBytes > maxBufferBytes) overflow('stderr');
      });
      proc.on('error', (caught: Error) => {
        finish({
          status: null,
          signal: null,
          stdout: AsyncChildProcess.mergeChunks(out, useUtf8),
          stderr: AsyncChildProcess.mergeChunks(err, useUtf8),
          error: caught,
        });
      });
      proc.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        finish({
          status: code,
          signal,
          stdout: AsyncChildProcess.mergeChunks(out, useUtf8),
          stderr: AsyncChildProcess.mergeChunks(err, useUtf8),
        });
      });
      // `spawn` 不会读 `options.input`：必须自己写 stdin 并关闭（否则等 stdin 的子进程会挂死）。
      // 没有 input 时也要 end()，与 spawnSync 的「空 stdin 立即 EOF」语义一致。
      if (proc.stdin !== null) {
        proc.stdin.on('error', () => {
          /* 子进程提前退出导致的 EPIPE 由 close/error 统一裁决 */
        });
        proc.stdin.end(options.input);
      }
    });
  }

  /**
   * 异步等价 `execFileSync`：正常退出返回 stdout 字符串；退出码非 0 或启动失败时**抛错**，
   * 错误对象携带 `status` / `signal` / `stdout` / `stderr`（与 `execFileSync` 一致）。
   * 默认按 UTF-8 收集（传 `encoding:'buffer'` 才返回 Buffer）。
   * @param file 可执行文件（或命令）。
   * @param args 参数列表。
   * @param options 透传给 `spawn` 的 `SpawnOptions`。
   * @returns 标准输出（字符串）。
   */
  public static async execFileAsync(
    file: string,
    args: ReadonlyArray<string> = [],
    options: RunProcessOptions = {},
  ): Promise<string> {
    const merged: RunProcessOptions = { ...options, encoding: options.encoding ?? 'utf8' };
    const result = await AsyncChildProcess.spawnSyncAsync(file, args, merged);
    if (result.error !== undefined || result.signal !== null || result.status !== 0) {
      const thrown =
        result.error ??
        new Error(
          result.signal !== null
            ? `command terminated by signal ${result.signal}`
            : `command exited with status ${String(result.status)}`,
        );
      Object.assign(thrown, {
        status: result.status,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
      });
      throw thrown;
    }
    return result.stdout as string;
  }

  /**
   * 合并流式分片为字符串或 Buffer。
   * @param chunks 分片数组（Buffer 或字符串）。
   * @param useUtf8 是否按 UTF-8 合并为字符串。
   * @returns 合并后的字符串或 Buffer。
   */
  private static mergeChunks(
    chunks: ReadonlyArray<Buffer | string>,
    useUtf8: boolean,
  ): string | Buffer {
    if (chunks.length === 0) return useUtf8 ? '' : Buffer.alloc(0);
    if (useUtf8) {
      return chunks
        .map((chunk) => (typeof chunk === 'string' ? chunk : chunk.toString('utf8')))
        .join('');
    }
    return Buffer.concat(
      chunks.map((chunk) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))),
    );
  }
}
