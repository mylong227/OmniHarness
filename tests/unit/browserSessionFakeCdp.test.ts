/**
 * BrowserSession 假 CDP 单测（任务②）：**不依赖真 Chrome**，用假 WebSocket + 假进程走通整条截图链路。
 *
 * 为什么必须补这层：browser_screenshot 的真实失败几乎全部发生在「找不到浏览器 / 起不来 / CDP 连不上」
 * 这三条平台路径上，而真机 e2e 只在装了 Chrome 的机器上跑、且一失败就是 EPERM/超时这种不可归因的形态。
 * 本文件把这三条路径变成**确定性单测**：注入假定位、假进程、假 CDP 连接，断言失败原因与资源回收。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSession } from '../../src/adapters/browser/browserSession.js';
import type { ChromeProcessLike } from '../../src/adapters/browser/browserSession.js';
import { CdpClient } from '../../src/adapters/browser/cdpClient.js';
import type { WebSocketLike } from '../../src/adapters/browser/cdpClient.js';
import type {
  ChromeLaunchResult,
  ChromeProcessOptions,
} from '../../src/adapters/browser/chromeProcess.js';
import type { ChromeLookup } from '../../src/adapters/browser/chromeLocator.js';

/** 最小合法 PNG（IHDR 报 320×200），用于假 CDP 返回截图数据。 */
const FAKE_PNG = ((): Buffer => {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(320, 16);
  buffer.writeUInt32BE(200, 20);
  return buffer;
})();

/** 一条已发出的 CDP 命令帧。 */
interface CdpFrame {
  readonly id?: number;
  readonly method?: string;
  readonly expression?: string;
}

/** 自动应答的假 WebSocket：按方法名回固定结果，并在导航后派发 load 事件。 */
class AutoCdpSocket implements WebSocketLike {
  /** 事件类型 → 监听器列表（假 CDP 不做真实 socket，只做同步派发）。 */
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  /** 已收到的命令帧（按序，供断言「复用同一浏览器」）。 */
  public readonly frames: CdpFrame[] = [];

  /** 置位后所有 send 都抛错（模拟通道在截图前已经断掉）。 */
  public broken = false;

  /**
   * 登记事件监听器（与 WebSocketLike 契约一致）。
   *
   * @param type 事件类型（open/message/close/error）
   * @param listener 监听器
   * @returns 无
   */
  public addEventListener(type: string, listener: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? [];
    set.push(listener);
    this.listeners.set(type, set);
  }

  /**
   * 发送一条 CDP 命令：记录帧、同步回固定应答，并在导航后补发 load 事件。
   *
   * @param data 命令帧 JSON
   * @returns 无
   */
  public send(data: string): void {
    if (this.broken) {
      throw new Error('WebSocket 已损坏');
    }
    const frame = JSON.parse(data) as CdpFrame & { params?: { expression?: string } };
    this.frames.push(frame);
    const result = AutoCdpSocket.resultOf(frame.method ?? '', frame.params?.expression ?? '');
    this.emit('message', { data: JSON.stringify({ id: frame.id, result }) });
    if (frame.method === 'Page.navigate') {
      this.emit('message', {
        data: JSON.stringify({ method: 'Page.loadEventFired', params: {} }),
      });
    }
  }

  /**
   * 关闭：向监听器派发 close 事件。
   *
   * @returns 无
   */
  public close(): void {
    this.emit('close', {});
  }

  /**
   * 触发一个事件。
   *
   * @param type 事件类型
   * @param event 事件负载
   * @returns 无
   */
  public emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  /**
   * 各 CDP 方法的固定应答。
   *
   * @param method CDP 方法名
   * @param expression Runtime.evaluate 的表达式（用于区分标题与最终地址）
   * @returns 该方法的固定 result 负载
   */
  private static resultOf(method: string, expression: string): unknown {
    switch (method) {
      case 'Target.createTarget':
        return { targetId: 'target-1' };
      case 'Target.attachToTarget':
        return { sessionId: 'session-1' };
      case 'Runtime.evaluate':
        return {
          result: {
            value: expression === 'document.title' ? 'Fake Title' : 'https://final.example/',
          },
        };
      case 'Page.captureScreenshot':
        return { data: FAKE_PNG.toString('base64') };
      case 'Page.navigate':
        return { frameId: 'frame-1' };
      default:
        return {};
    }
  }
}

/** 记录生命周期的假浏览器进程。 */
class FakeChromeProcess implements ChromeProcessLike {
  /** kill 调用次数。 */
  public kills = 0;
  /** launch 调用次数。 */
  public launches = 0;
  /** 置位后 launch 抛错（模拟「起不来」）。 */
  public failWith: Error | undefined;

  public constructor(private readonly url = 'ws://127.0.0.1:9222/devtools/browser/fake') {}

  /**
   * 假启动：计数，必要时抛错，否则给出 DevTools 端点。
   *
   * @returns 启动结果（CDP WebSocket 地址 + 端口）
   */
  public async launch(): Promise<ChromeLaunchResult> {
    this.launches += 1;
    if (this.failWith !== undefined) {
      throw this.failWith;
    }
    return { webSocketUrl: this.url, port: 9222 };
  }

  /**
   * 假回收：只计数，供断言「失败不留孤儿进程」。
   *
   * @returns 无
   */
  public kill(): void {
    this.kills += 1;
  }
}

/** 造一个「找得到浏览器」的定位结果。 */
const foundLookup = (path = '/fake/chrome'): ChromeLookup => ({
  executable: path,
  searched: [path],
});

/** 造一个已接线的会话（假定位 + 假进程 + 假 CDP）。 */
const makeSession = (
  options: {
    readonly lookup?: ChromeLookup;
    readonly socket?: AutoCdpSocket;
    readonly process?: FakeChromeProcess;
    readonly connectFails?: Error;
  } = {},
): {
  readonly session: BrowserSession;
  readonly socket: AutoCdpSocket;
  readonly chrome: FakeChromeProcess;
  readonly seenProcessOptions: ChromeProcessOptions[];
} => {
  const socket = options.socket ?? new AutoCdpSocket();
  const chrome = options.process ?? new FakeChromeProcess();
  const seenProcessOptions: ChromeProcessOptions[] = [];
  const session = new BrowserSession({
    locate: () => options.lookup ?? foundLookup(),
    createProcess: (processOptions) => {
      seenProcessOptions.push(processOptions);
      return chrome;
    },
    connectCdp: async (url: string) => {
      if (options.connectFails !== undefined) {
        throw options.connectFails;
      }
      const client = new CdpClient({ webSocket: () => socket, timeoutMs: 1000 });
      // 先发起连接再派发 open（反过来会死等：connect 的 Promise 只由 open/error 结算）。
      const ready = client.connect(url);
      socket.emit('open', {});
      await ready;
      return client;
    },
  });
  return { session, socket, chrome, seenProcessOptions };
};

test('假 CDP 全链路：截图返回真实 PNG 字节、尺寸取 PNG 头、最终地址与标题', async () => {
  const { session, socket } = makeSession();
  const shot = await session.screenshot({
    url: 'https://example.com/',
    width: 1280,
    height: 800,
    fullPage: false,
    waitMs: 0,
  });

  assert.strictEqual(shot.png.subarray(0, 4).toString('hex'), '89504e47', 'PNG 魔数');
  assert.strictEqual(shot.width, 320, '尺寸必须来自 PNG 头而非请求参数');
  assert.strictEqual(shot.height, 200);
  assert.strictEqual(shot.finalUrl, 'https://final.example/');
  assert.strictEqual(shot.title, 'Fake Title');
  const methods = socket.frames.map((frame) => frame.method);
  assert.ok(methods.includes('Emulation.setDeviceMetricsOverride'));
  assert.ok(methods.includes('Page.navigate'));
  assert.ok(methods.includes('Page.captureScreenshot'));
  await session.close();
});

test('跨调用复用同一个浏览器（不每次冷启 Chromium）', async () => {
  const { session, chrome, socket } = makeSession();
  await session.screenshot({
    url: 'https://a.example/',
    width: 800,
    height: 600,
    fullPage: false,
    waitMs: 0,
  });
  await session.screenshot({
    url: 'https://b.example/',
    width: 800,
    height: 600,
    fullPage: false,
    waitMs: 0,
  });

  assert.strictEqual(chrome.launches, 1, '只应启动一次浏览器');
  assert.strictEqual(
    socket.frames.filter((frame) => frame.method === 'Target.createTarget').length,
    1,
    '只应建一次页',
  );
  await session.close();
});

test('close() 幂等：关页 + 杀进程，重复调用不再动进程', async () => {
  const { session, chrome, socket } = makeSession();
  await session.screenshot({
    url: 'https://a.example/',
    width: 800,
    height: 600,
    fullPage: false,
    waitMs: 0,
  });
  await session.close();
  await session.close();
  assert.strictEqual(chrome.kills, 1);
  assert.ok(
    socket.frames.some((frame) => frame.method === 'Page.close'),
    '应主动关掉页面会话',
  );
});

test('找不到浏览器 → 可执行原因里给出 CHROME_PATH，且不进「起进程」步骤', async () => {
  const { session, seenProcessOptions } = makeSession({
    lookup: { executable: null, searched: ['/a/chrome', '/b/chrome'] },
  });
  await assert.rejects(
    session.screenshot({
      url: 'https://a.example/',
      width: 800,
      height: 600,
      fullPage: false,
      waitMs: 0,
    }),
    /未找到 Chrome\/Edge[\s\S]*CHROME_PATH/,
  );
  assert.deepStrictEqual(seenProcessOptions, [], '找不到浏览器时不该构造进程');
});

test('浏览器起不来 → 抛错且进程被回收（失败不留孤儿进程）', async () => {
  const chrome = new FakeChromeProcess();
  chrome.failWith = new Error('浏览器未在 30000ms 内上报 DevTools 端点');
  const { session } = makeSession({ process: chrome });
  await assert.rejects(
    session.screenshot({
      url: 'https://a.example/',
      width: 800,
      height: 600,
      fullPage: false,
      waitMs: 0,
    }),
    /DevTools 端点/,
  );
  assert.strictEqual(chrome.kills, 1, '启动中途失败必须收干净');
});

test('CDP 连不上 → 抛错且同样回收进程', async () => {
  const chrome = new FakeChromeProcess();
  const { session } = makeSession({
    process: chrome,
    connectFails: new Error('CDP 连接超时（15000ms）: ws://127.0.0.1:9222/devtools/browser/fake'),
  });
  await assert.rejects(
    session.screenshot({
      url: 'https://a.example/',
      width: 800,
      height: 600,
      fullPage: false,
      waitMs: 0,
    }),
    /CDP 连接超时/,
  );
  assert.strictEqual(chrome.kills, 1);
});

test('关闭后的会话再次截图 → 明确报「已关闭」（不静默重启浏览器）', async () => {
  const { session } = makeSession();
  await session.close();
  await assert.rejects(
    session.screenshot({
      url: 'https://a.example/',
      width: 800,
      height: 600,
      fullPage: false,
      waitMs: 0,
    }),
    /已关闭/,
  );
});
