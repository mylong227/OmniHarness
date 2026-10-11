import { spawn } from 'node:child_process';
import type {
  MediaProcessOutcome,
  MediaProcessRequest,
  MediaProcessRunner,
} from './mediaProcessRunner.js';

/** stderr 保留上限（人类可读的探测信息；超出只影响诊断细节，不影响判定）。 */
const MAX_STDERR_BYTES = 256 * 1024;

/**
 * 已启动子进程里本执行器真正用到的最小面（`ChildProcess` 的窄化）。
 *
 * 存在的理由：本类的**判定**（超时真杀、输出截断、ENOENT 不炸宿主、收尾清理）全都
 * 发生在事件回调里，只有能注入替身进程才可判——而 `ChildProcess` 是个巨型接口，
 * 单测无法构造。窄化后替身只需实现这 4 个成员。
 */
export interface SpawnedMediaChild {
  /** stdout 数据流（本类只订阅 `data`）。 */
  readonly stdout: { on(event: 'data', listener: (chunk: Buffer) => void): unknown };
  /** stderr 数据流（本类只订阅 `data`）。 */
  readonly stderr: { on(event: 'data', listener: (chunk: Buffer) => void): unknown };
  /**
   * 订阅进程事件。
   *
   * @param event 事件名（`error` / `close`）。
   * @param listener 事件回调。
   * @returns 无返回值（实现多返回 `this`，本类不依赖）。
   */
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: (code: number | null) => void): unknown;
  /**
   * 终止进程（超时与取消两条路径都用它）。
   *
   * @returns 无返回值（实现多返回是否成功，本类不依赖）。
   */
  kill(): void;
}

/** 子进程启动函数（注入缝）：缺省即 `node:child_process.spawn`。 */
export type MediaChildSpawner = (command: string, args: readonly string[]) => SpawnedMediaChild;

/**
 * 缺省启动实现：真的是 `node:child_process.spawn`，启动参数与本次改造前**逐字一致**
 * （`stdio: ['ignore', 'pipe', 'pipe']` + `windowsHide: true`）。
 *
 * @param command 可执行文件路径（绝对路径或 PATH 中的名字）。
 * @param args 参数数组（**不经 shell**）。
 * @returns 已启动的子进程。
 */
const spawnRealChild: MediaChildSpawner = (command, args) =>
  spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

/**
 * 基于 `child_process.spawn` 的媒体子进程执行器（生产实现）。
 *
 * ## 三条硬约束（都对应真实事故形态）
 *
 * 1. **绝不静默挂死**：外部二进制在坏输入上可能既不退出也不产出（等待 stdin、
 *    等待一个不存在的设备）。故超时必须**到点强杀**，且计时器**不加 `unref()`**
 *    （本仓既有教训：`unref()` 的等待计时器在事件循环别无句柄时永不触发，
 *    守卫会在最需要它的那一刻静默失效）。
 * 2. **绝不无界累积**：视频抽帧是「往 stdout 倒图片」，一帧几 MB，不设上限时
 *    一条命令就能把进程内存吃光。达到上限即**停止累积**（进程继续跑到 `-frames:v` 或超时），
 *    并置 `truncated` 让调用方知道最后一帧可能不完整。
 * 3. **不用 shell**：`spawn` 走 argv 数组，参数里的正则/引号/反斜杠不会被 shell 二次解释
 *    （本仓的 ffmpeg 滤镜串恰好满是 `,` 与 `'`，走 shell 必炸）。
 *
 * stdin 一律置 `ignore`：ffmpeg 在 stdin 被占用时会读它（`-nostdin` 之外的第二道保险）。
 */
export class SpawnMediaProcessRunner implements MediaProcessRunner {
  /** 子进程启动函数（注入缝）；缺省即真实 `node:child_process.spawn`。 */
  private readonly spawnChild: MediaChildSpawner;

  /**
   * @param spawnChild 子进程启动函数；省略时使用真实 `node:child_process.spawn`。
   */
  public constructor(spawnChild: MediaChildSpawner = spawnRealChild) {
    this.spawnChild = spawnChild;
  }

  /**
   * 执行一条受控子进程。
   *
   * @param request 执行请求。
   * @returns 单次执行结果（不抛异常）。
   */
  public run(request: MediaProcessRequest): Promise<MediaProcessOutcome> {
    return new Promise<MediaProcessOutcome>((resolve) => {
      const chunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let truncated = false;
      let timedOut = false;
      let settled = false;
      const child = this.spawnChild(request.command, [...request.args]);
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, request.timeoutMs);
      const onAbort = (): void => {
        child.kill();
      };
      request.signal?.addEventListener('abort', onAbort, { once: true });
      const finish = (outcome: MediaProcessOutcome): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        request.signal?.removeEventListener('abort', onAbort);
        resolve(outcome);
      };
      child.stdout.on('data', (chunk: Buffer) => {
        if (stdoutBytes >= request.maxOutputBytes) {
          truncated = true;
          return;
        }
        const remaining = request.maxOutputBytes - stdoutBytes;
        const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        if (slice.length < chunk.length) {
          truncated = true;
        }
        chunks.push(Buffer.from(slice));
        stdoutBytes += slice.length;
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderrBytes >= MAX_STDERR_BYTES) {
          return;
        }
        const slice = chunk.subarray(0, MAX_STDERR_BYTES - stderrBytes);
        stderrChunks.push(Buffer.from(slice));
        stderrBytes += slice.length;
      });
      // 未监听 'error' 会让一次 ENOENT 变成**未捕获异常**并炸掉宿主进程（本仓既有教训）。
      child.on('error', (error: Error) => {
        finish({
          exitCode: null,
          stdout: Buffer.concat(chunks),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          timedOut,
          truncated,
          spawnError: error.message,
        });
      });
      child.on('close', (code: number | null) => {
        finish({
          exitCode: code,
          stdout: Buffer.concat(chunks),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          timedOut,
          truncated,
          spawnError: undefined,
        });
      });
    });
  }
}
