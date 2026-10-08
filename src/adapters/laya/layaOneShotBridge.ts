/**
 * Laya 单发桥（一次性子进程）：一个请求 → 一个响应 → 进程退出。
 *
 * ## 为什么保留这条路径
 *
 * 它在**常驻热进程不可用**时仍是可用后路（也用于 `warm:false` 的显式配置与单测）：
 * 不依赖长驻句柄、不占用常驻内存，代价是每次都要重新 `import torch` 并加载权重
 * （本机实测冷启约 62s、暖盘约 18s）。
 *
 * ## 三条纪律（都是实测/评审教训，不是风格偏好）
 *
 * 1. **请求走临时文件而非 stdin 管道**：本机 Windows 上同步子进程一旦建 stdin 管道即 `EBUSY`，
 *    故 stdio 只开 stdout（`execFile` 下 stdin 默认忽略），请求经 `--request-file` 投递。
 * 2. **异步子进程，不用 `execFileSync`**：同步子进程会**阻塞事件循环**整整一次推理的时长
 *    （实测 18–62s）——在 serve / UI 场景里等同于整机卡死。
 * 3. **超时必须自己收**（2026-10-07 评审发现的真缺陷）：这里原先走
 *    `AsyncChildProcess.execFileAsync(..., { timeout })`，而 Node 的 **`spawn` 根本不支持
 *    `timeout` 选项**（只有 `exec` / `execFile` 支持），`AsyncChildProcess` 也不注册任何计时器
 *    ⇒ 超时形同虚设：在线 Router 路径网络卡住、或 Python 挂死时 `decide` **永不返回**，
 *    与「fail-open 不阻断主流程」的契约直接冲突。现在用 `execFile`（原生支持 `timeout`）并显式
 *    `killSignal: 'SIGKILL'`，确保到点真的杀掉。
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LayaBridgeResponse } from './layaQuestionTranslator.js';

/** 单发桥配置。 */
export interface LayaOneShotBridgeOptions {
  /** Python 解释器路径。 */
  readonly pythonPath: string;
  /** 桥脚本路径（`laya_infer.py`）。 */
  readonly scriptPath: string;
  /** 单次调用上限（毫秒）。 */
  readonly timeoutMs: number;
  /** HuggingFace 镜像端点。 */
  readonly hfEndpoint: string;
}

/** 子进程失败时携带的诊断字段（`execFile` 的 error 上就有）。 */
interface ExecErrorCarrier {
  /** 退出码（被杀时为 null）。 */
  readonly status?: number | null;
  /** 终止信号（超时被杀时为 `SIGKILL`）。 */
  readonly signal?: string | null;
  /** 标准错误（字符串形态）。 */
  readonly stderr?: unknown;
  /** 标准输出（字符串形态）。 */
  readonly stdout?: unknown;
  /** 错误消息。 */
  readonly message?: unknown;
}

/**
 * 单发桥：把一次请求投给一次性 Python 子进程。
 *
 * 失败一律**抛错**（超时 / 非零退出 / 输出不可解析），由调用方决定 fail-open 口径——
 * 传输层不吞错，避免「静默把坏后端当可用」。
 */
export class LayaOneShotBridge {
  /**
   * @param options 桥配置（解释器 / 脚本 / 超时 / 镜像端点）。
   */
  public constructor(private readonly options: LayaOneShotBridgeOptions) {}

  /**
   * 投递一次请求并解析响应。
   *
   * @param payload 请求体（`{ probe }` / `{ warmup }` / `{ repo, modelDir, request }`）。
   * @returns 桥响应。
   * @throws Error 子进程启动失败、超时（`timeoutMs`，进程会被 `SIGKILL` 杀掉）、
   *   非零退出或输出不可解析时抛出（附 stderr 摘要与超时标记）。
   */
  public async request(payload: Readonly<Record<string, unknown>>): Promise<LayaBridgeResponse> {
    // `.bat` / `.cmd` 包装在 Windows 上要借道 `cmd.exe`，而 `execFile` 不会自己做这件事；
    // 与其让它以 ENOENT / EINVAL 的形式静默降级，不如在这里给出可执行的建议（指向 python.exe）。
    LayaOneShotBridge.rejectWrapperInterpreter(this.options.pythonPath);
    const reqFile = this.writeRequestFile(JSON.stringify(payload));
    try {
      const stdout = await this.spawnBridge(reqFile);
      return LayaOneShotBridge.parseFrame(stdout);
    } finally {
      try {
        unlinkSync(reqFile);
      } catch {
        /* 临时文件清理失败不阻断主流程 */
      }
    }
  }

  /**
   * 起一次性子进程并收 stdout（`execFile` 原生支持超时与 killSignal）。
   *
   * @param reqFile 请求临时文件路径。
   * @returns 子进程 stdout。
   * @throws Error 失败 / 超时 / 非零退出时抛出（消息已含归因摘要）。
   */
  private spawnBridge(reqFile: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      execFile(
        this.options.pythonPath,
        [this.options.scriptPath, '--request-file', reqFile],
        {
          timeout: this.options.timeoutMs,
          // 默认 SIGTERM 在 Windows 上未必终止 Python 子进程；SIGKILL 才是「到点必杀」。
          killSignal: 'SIGKILL',
          windowsHide: true,
          encoding: 'utf8',
          env: { ...process.env, HF_ENDPOINT: this.options.hfEndpoint },
        },
        (error, stdout) => {
          if (error !== null && error !== undefined) {
            reject(new Error(LayaOneShotBridge.describe(error, this.options.timeoutMs)));
            return;
          }
          resolve(typeof stdout === 'string' ? stdout : String(stdout));
        },
      );
    });
  }

  /**
   * 把请求 JSON 写入临时文件（调用方负责用完删除）。
   *
   * @param text 请求 JSON 文本。
   * @returns 临时文件绝对路径。
   */
  private writeRequestFile(text: string): string {
    const path = join(tmpdir(), `laya-req-${randomUUID()}.json`);
    writeFileSync(path, text, 'utf8');
    return path;
  }

  /**
   * 拒绝 `.bat` / `.cmd` 解释器包装（`execFile` 不会自动借道 `cmd.exe`）。
   *
   * @param pythonPath 解释器路径。
   * @returns 无返回值。
   * @throws Error 指向 `.bat` / `.cmd` 时抛出（附建议）。
   */
  private static rejectWrapperInterpreter(pythonPath: string): void {
    if (/\.(bat|cmd)$/i.test(pythonPath)) {
      throw new Error(`不支持 .bat/.cmd 解释器包装（请指向 python.exe；收到 ${pythonPath}）`);
    }
  }

  /**
   * 解析桥输出：取最后一个非空行（协议每帧一行；库噪声若混入也不会顶掉末帧）。
   *
   * @param stdout 桥的 stdout。
   * @returns 桥响应。
   * @throws Error 无有效帧或 JSON 不可解析时抛出。
   */
  private static parseFrame(stdout: string): LayaBridgeResponse {
    const line = stdout
      .split('\n')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .pop();
    if (line === undefined) {
      throw new Error('桥无输出（进程可能被超时终止）');
    }
    try {
      return JSON.parse(line) as LayaBridgeResponse;
    } catch {
      throw new Error(`桥输出不可解析：${line.slice(0, 200)}`);
    }
  }

  /**
   * 把子进程失败整理成一句可读原因（超时 / 信号 / 退出码 + stderr 摘要）。
   *
   * @param error 捕获到的错误（`execFile` 的 error，携带 `status` / `signal` / `stderr` / `stdout`）。
   * @param timeoutMs 本桥的超时上限（用于把「被超时杀掉」与「自己崩了」区分开）。
   * @returns 归因文本。
   */
  private static describe(error: unknown, timeoutMs: number): string {
    const carrier = error as ExecErrorCarrier;
    const message = typeof carrier.message === 'string' ? carrier.message : String(error);
    const killed = carrier.signal === 'SIGKILL' || carrier.signal === 'SIGTERM';
    const timedOut = killed || message.includes('ETIMEDOUT');
    const head = timedOut
      ? `单发桥超时（>${timeoutMs}ms，已杀进程）`
      : `单发桥调用失败：${message}`;
    const status =
      carrier.status === undefined || carrier.status === null
        ? ''
        : ` (status=${String(carrier.status)})`;
    const stderr = typeof carrier.stderr === 'string' ? carrier.stderr.trim() : '';
    const stdout = typeof carrier.stdout === 'string' ? carrier.stdout.trim() : '';
    const detail = stderr.length > 0 ? stderr : stdout;
    return `${head}${status}${detail.length > 0 ? `｜${detail.slice(-200)}` : ''}`;
  }
}
