/**
 * 一键启动的**就绪探针、退出文案与外壳命令**（从 `scripts/startAll.mjs` 抽出，2026-10-13）。
 *
 * ## 为什么要独立成模块
 *
 * `startAll.mjs` 是**入口脚本**（import 即执行「构建 → 起服务」），单测无法 import 它；
import { resolveDevAddress } from '../devConfig.mjs';
 * 而「等服务真的就绪再打开浏览器」这件事必须**可判**——否则"一键启动"会以三种形态骗人：
 *  1. 构建还没完就打开浏览器 ⇒ **白屏**，用户以为前端坏了（本仓的经典误判）；
 *  2. 端口上其实是**别的进程**（两天前还在跑的旧 serve / 别人的 HTTP 服务）⇒ 打开的是**别人的页面**；
 *  3. 超时后静默不打开 ⇒ 双击了却"什么都没发生"，比不提供这个功能更糟。
 *
 * 故把纯逻辑抽到这里：**零 I/O、零依赖**，由 `tests/unit/launchReadiness.test.ts` 逐条钉住；
 * 入口脚本只留 I/O（真实 `fetch`、真实 `spawn`）与打印。
 */

/**
 * `serve` 的缺省端口。
 *
 * **不得自成一源**：权威实现是 `src/cli/cliServerCmds.ts` 的 `--port ?? 8787`，
 * 本常量只是让启动器能在**尚未起服务**时就知道该探哪个端口；两者一致由单测核对
 * （历史上这仓吃够了"同一事实抄两份、抄的时候就漂了"的亏）。
 */
/* DEFAULT_SERVE_PORT 已收口到 ../devConfig.mjs（resolveDevAddress().backendPort）。 */

/** 就绪轮询的缺省节奏（毫秒）。 */
export const DEFAULT_POLL_MS = 400;

/** 就绪轮询的缺省上限（毫秒）。首次 `npm start` 要现编前后端，给足三分钟。 */
export const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * 从透传给 `serve` 的参数里解析监听端口。
 *
 * 支持 `--port 9000` 与 `--port=9000` 两种写法（`serve` 自己两种都吃）；
 * 缺失 / 非数字 / 越界（≤0 或 >65535）一律回落到 {@link DEFAULT_SERVE_PORT}——
 * 宁可探错端口后给出可读超时提示，也不要在启动器里复刻一套旗标校验（那是第二份真相）。
 * @param args 透传给 `serve` 的参数数组。
 * @returns 端口号。
 */
export function resolveServePort(args) {
  const list = Array.isArray(args) ? args : [];
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    if (item === '--port') {
      return normalizePort(list[i + 1]);
    }
    if (typeof item === 'string' && item.startsWith('--port=')) {
      return normalizePort(item.slice('--port='.length));
    }
  }
  return resolveDevAddress().backendPort;
}

/**
 * 把一处端口写法归一为合法端口。
 * @param raw 原始值（可能是 undefined / 空串 / 任意文本）。
 * @returns 合法端口，或缺省端口。
 */
function normalizePort(raw) {
  const value = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    return DEFAULT_SERVE_PORT;
  }
  return value;
}

/**
 * 就绪探针的地址。
 *
 * 用 `/readyz` 而不是 `/healthz`：前者是**就绪**探针（核心组件齐备才 200，否则 503），
 * 后者恒 200 只证明"进程能响应"——在两者之间选错，就等于把"还没准备好"当"已就绪"。
 * @param port 端口号。
 * @returns 探针 URL（**写 `127.0.0.1` 而不是 `localhost`**：本机 serve 只绑回环，
 *   而 Windows 上 `localhost` 可能先解析到 `::1` 而连不上）。
 */
export function readinessUrl(port) {
  return `http://${resolveDevAddress().host}:${String(port)}/readyz`;
}

/**
 * 归类一次就绪探针的结果。
 *
 * 分支刻意穷尽（这是一条 fail-closed 的分类，不是"能不能连上"的布尔）：
 *  - `down`：连不上（还没起来 / 正在构建 / 端口没人听）⇒ 继续轮询；
 *  - `degraded`：有响应且**自述是本程序**但核心组件没齐（503）⇒ 继续轮询；
 *  - `ready`：200 且 `status === 'ok'` ⇒ 可以开浏览器；
 *  - `guarded`：401/403 ⇒ **服务已起来**（只是配了鉴权），仍然开浏览器（用户自己去登）；
 *  - `foreign`：有响应，但**不是本程序的健康体**（非 JSON / 缺字段 / 其它状态码）⇒ 端口被别的
 *    进程占着，开浏览器只会打开别人的页面，故**立即终止轮询**并如实说明。
 * @param input 一次探测的观测结果。
 * @returns 上述五个标签之一。
 */
export function classifyReadyProbe(input) {
  const { statusCode, bodyText, error } = input ?? {};
  if (error !== undefined && error !== null) {
    return 'down';
  }
  if (typeof statusCode !== 'number') {
    // 没有异常、也没有状态码 ⇒ 观测本身不可信，按"没起来"处理（绝不乐观判就绪）。
    return 'down';
  }
  if (statusCode === 401 || statusCode === 403) {
    return 'guarded';
  }
  const parsed = parseJsonRecord(bodyText);
  if (parsed === undefined) {
    return statusCode >= 200 && statusCode < 300 ? 'foreign' : 'down';
  }
  const status = parsed.status;
  if (statusCode >= 200 && statusCode < 300 && status === 'ok') {
    return 'ready';
  }
  if (typeof status === 'string') {
    // 本程序的健康体（认得出形状）：503/degraded 属"起来了但没就绪"，值得继续等。
    return statusCode === 503 ? 'degraded' : 'down';
  }
  return 'foreign';
}

/**
 * 安全解析 JSON 对象（非对象 / 非 JSON 一律 undefined，不抛）。
 * @param text 响应体文本。
 * @returns 解析出的普通对象，或 undefined。
 */
function parseJsonRecord(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * 轮询就绪探针直到**可开浏览器**或超时。
 *
 * 依赖全部注入（`probe` / `sleep` / `now`）⇒ 单测无需真网络、无需真等待即可覆盖全部分支
 * （本仓对"仪器会不会骗人"有明确要求：判据必须能在不联网的机器上真跑）。
 * @param options 轮询配置。
 * @returns 终局结果：`outcome` 为 `ready`/`guarded`/`foreign`/`timeout`，附尝试次数与最后一次观测。
 */
export async function waitForReady(options) {
  const {
    probe,
    sleep,
    now,
    pollMs = DEFAULT_POLL_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options ?? {};
  if (typeof probe !== 'function') {
    throw new TypeError('waitForReady 需要注入 probe（返回 classifyReadyProbe 的标签）');
  }
  const startedAt = typeof now === 'function' ? now() : Date.now();
  const wait = typeof sleep === 'function' ? sleep : defaultSleep;
  const clock = typeof now === 'function' ? now : Date.now;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const kind = await probe();
    if (kind === 'ready' || kind === 'guarded' || kind === 'foreign') {
      return { outcome: kind, attempts, lastKind: kind };
    }
    if (clock() - startedAt >= timeoutMs) {
      return { outcome: 'timeout', attempts, lastKind: kind };
    }
    await wait(pollMs);
  }
}

/**
 * 缺省的等待实现（仅 `waitForReady` 未注入 `sleep` 时使用）。
 * @param ms 毫秒。
 * @returns 定时 Promise。
 */
function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 就绪结果的**可读文案**（不含"成功了"这类乐观话术：没就绪就直说没就绪）。
 * @param outcome 终局标签。
 * @param port 端口号（用于提示里给准确地址）。
 * @returns 一行文案。
 */
export function describeReadyOutcome(outcome, port) {
  const addr = `http://${resolveDevAddress().host}:${String(port)}`;
  switch (outcome) {
    case 'ready':
      return `✓ 工作台已就绪：${addr}`;
    case 'guarded':
      return `✓ 工作台已就绪（配了鉴权，需登录）：${addr}`;
    case 'foreign':
      return (
        `✗ 端口 ${String(port)} 上有响应，但**不是本程序的健康体** ⇒ 多半被别的进程占着，` +
        '本次未打开浏览器。换端口：npm start -- --port 9000'
      );
    default:
      return (
        `✗ 等待就绪超时（${String(port)} 端口仍不可用）⇒ 未打开浏览器。` +
        '请看上方 serve 的输出：端口被占会给出三条出路，构建失败会给出失败门禁。'
      );
  }
}

/**
 * 描述 `serve` 的退出码。
 *
 * 为什么需要：双击启动时窗口一关就没线索；"退出码 1"与"用户按了 Ctrl+C"必须区分开，
 * 否则每次正常停止都被当成故障，而真正的故障又混在噪音里。
 * @param code 子进程退出码（null 表示被信号终止）。
 * @returns 一行文案。
 */
export function describeServeExit(code) {
  if (code === null || code === undefined) {
    return 'serve 已结束（未拿到退出码，多半是被信号终止）。';
  }
  // Windows 控制台里 Ctrl+C 常见形态：130（POSIX 口径）与 3221225786（0xC000013A，NTSTATUS 口径）。
  if (code === 130 || code === 3221225786) {
    return 'serve 已按 Ctrl+C 停止。';
  }
  if (code === 0) {
    return 'serve 已正常结束（退出码 0）。';
  }
  return (
    `✗ serve 以退出码 ${String(code)} 结束。` +
    '常见两因：① 构建/门禁失败（看上方 ✗ 行）；② 端口被占（看上方三条出路）。'
  );
}

/**
 * 生成"打开浏览器"的系统命令（跨平台，零依赖）。
 *
 * Windows 上必须经 `cmd /c start`：`start` 是 cmd 内建命令，没有独立可执行文件；
 * 第二个参数是**窗口标题**，必须占位（否则形如 `http://…?a=b` 的 URL 会被当成标题）。
 * @param platform `process.platform` 的值。
 * @param url 目标地址。
 * @returns `{ command, args }`；平台不支持时返回 null（调用方据此跳过并如实说明）。
 */
export function browserOpenCommand(platform, url) {
  const target = String(url);
  if (platform === 'win32') {
    return { command: 'cmd', args: ['/c', 'start', '', target] };
  }
  if (platform === 'darwin') {
    return { command: 'open', args: [target] };
  }
  if (platform === 'linux') {
    return { command: 'xdg-open', args: [target] };
  }
  return null;
}
