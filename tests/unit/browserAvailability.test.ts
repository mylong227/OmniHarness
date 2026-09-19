/**
 * browser_screenshot 可用性探测与失败可执行原因单测（任务②）：全程不依赖真 Chrome、不发真网络请求。
 *
 * 覆盖三件产品化必需的事：
 * 1. **注册前探测**：没有浏览器且没有可连的 CDP 端点时，如实报不可用（避免暴露必然失败的死工具）；
 * 2. **三类失败分得开**：未装浏览器 / CDP 端点连不上 / 探测超时，各自给**可执行**补救；
 * 3. **探测不 spawn 进程**：判定只依赖可注入的定位函数与环境变量。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserAvailability } from '../../src/adapters/browser/browserAvailability.js';
import { BrowserScreenshotTool } from '../../src/adapters/tool/browser/browserScreenshotTool.js';
import type { ChromeLookup } from '../../src/adapters/browser/chromeLocator.js';
import type { ScreenshotSession } from '../../src/adapters/tool/browser/browserScreenshotTool.js';
import type {
  ScreenshotRequest,
  ScreenshotResult,
} from '../../src/adapters/browser/browserSession.js';
import type { ToolCall, ToolContext } from '../../src/ports/tool/tool.js';

/** 定位结果：命中。 */
const found = (path = '/fake/chrome'): ChromeLookup => ({ executable: path, searched: [path] });

/** 定位结果：未命中。 */
const missing: ChromeLookup = { executable: null, searched: ['/usr/bin/google-chrome'] };

/** 只抛错的假会话（用于验证失败文案映射）。 */
class ThrowingSession implements ScreenshotSession {
  /**
   * 固定抛同一条错误的假会话。
   *
   * @param error 每次截图都要抛出的错误
   */
  public constructor(private readonly error: Error) {}

  /**
   * 抛错（模拟真实截图的失败）。
   *
   * @param _request 截图请求（本假实现不使用）
   * @returns 永不返回——总是抛出构造时注入的错误
   */
  public async screenshot(_request: ScreenshotRequest): Promise<ScreenshotResult> {
    throw this.error;
  }

  /**
   * 假关闭：无资源可回收。
   *
   * @returns 无
   */
  public async close(): Promise<void> {
    /* 无资源 */
  }
}

test('探测：找得到浏览器 ⇒ 可用（理由给出可执行文件路径）', async () => {
  const report = await BrowserAvailability.probe({ locate: () => found('/x/chrome.exe') });
  assert.strictEqual(report.available, true);
  assert.strictEqual(report.executable, '/x/chrome.exe');
  assert.strictEqual(report.kind, null);
  assert.match(report.reason, /\/x\/chrome\.exe/);
});

test('探测：没浏览器也没端点 ⇒ 不可用，类别 chrome-missing 且建议含 CHROME_PATH', async () => {
  const report = await BrowserAvailability.probe({ locate: () => missing });
  assert.strictEqual(report.available, false);
  assert.strictEqual(report.kind, 'chrome-missing');
  assert.match(report.reason, /CHROME_PATH/);
  assert.match(report.reason, /安装 Google Chrome/);
  assert.match(report.reason, /已查找：/);
});

test('探测：配置了 OMNI_CDP_ENDPOINT 且端点连通 ⇒ 可用（不再要求本机装浏览器）', async () => {
  const report = await BrowserAvailability.probe({
    env: { OMNI_CDP_ENDPOINT: 'http://127.0.0.1:9222' },
    locate: () => missing,
    probeEndpoint: async () => {
      /* 连通 */
    },
  });
  assert.strictEqual(report.available, true);
  assert.strictEqual(report.endpoint, 'http://127.0.0.1:9222');
  assert.match(report.reason, /附着到该浏览器/);
});

test('探测：端点连不上 ⇒ 类别 cdp-unreachable，建议指向该环境变量', async () => {
  const report = await BrowserAvailability.probe({
    endpoint: 'http://127.0.0.1:1',
    locate: () => missing,
    probeEndpoint: async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:1');
    },
  });
  assert.strictEqual(report.available, false);
  assert.strictEqual(report.kind, 'cdp-unreachable');
  assert.match(report.reason, /OMNI_CDP_ENDPOINT/);
  assert.match(report.reason, /ECONNREFUSED/);
});

test('探测：端点超时（AbortError）⇒ 类别 cdp-timeout，建议可执行', async () => {
  const abort = new Error('This operation was aborted');
  abort.name = 'AbortError';
  const report = await BrowserAvailability.probe({
    endpoint: 'http://127.0.0.1:9222',
    locate: () => missing,
    probeEndpoint: async () => {
      throw abort;
    },
  });
  assert.strictEqual(report.kind, 'cdp-timeout');
  assert.match(report.reason, /防火墙|自启路径/);
});

test('classifyError：三类失败与小写归一', () => {
  assert.strictEqual(
    BrowserAvailability.classifyError(new Error('未找到 Chrome/Edge 可执行文件。可用 CHROME_PATH')),
    'chrome-missing',
  );
  assert.strictEqual(
    BrowserAvailability.classifyError(new Error('CDP WebSocket 已关闭')),
    'cdp-unreachable',
  );
  assert.strictEqual(
    BrowserAvailability.classifyError(new Error('浏览器未在 30000ms 内上报 DevTools 端点')),
    'cdp-timeout',
  );
  assert.strictEqual(BrowserAvailability.classifyError('莫名其妙'), 'unknown');
});

test('versionUrl：ws/http 两种端点都规范成 /json/version', () => {
  assert.strictEqual(
    BrowserAvailability.versionUrl('ws://127.0.0.1:9222/devtools/browser/abc'),
    'http://127.0.0.1:9222/json/version',
  );
  assert.strictEqual(
    BrowserAvailability.versionUrl('wss://host:443/devtools/browser/abc'),
    'https://host:443/json/version',
  );
  assert.strictEqual(
    BrowserAvailability.versionUrl('http://127.0.0.1:9222/'),
    'http://127.0.0.1:9222/json/version',
  );
});

test('工具静态入口：availability 委托探测（组合根据此决定是否注册）', async () => {
  const report = await BrowserScreenshotTool.availability({ locate: () => missing });
  assert.strictEqual(report.available, false);
  assert.strictEqual(report.kind, 'chrome-missing');
});

test('失败文案：未装浏览器 ⇒ 带「未安装浏览器」标签与 CHROME_PATH 建议', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brow-avail-'));
  try {
    const tool = new BrowserScreenshotTool(
      dir,
      () => new ThrowingSession(new Error('未找到 Chrome/Edge 可执行文件。可用 CHROME_PATH 指定')),
    );
    const result = await tool.handle(call({ url: 'https://example.com' }), ctx(dir));
    assert.strictEqual(result.ok, false);
    assert.match(result.error ?? '', /网页截图失败（未安装浏览器）/);
    assert.match(result.error ?? '', /CHROME_PATH/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('失败文案：CDP 端点不可达 ⇒ 标签 + 指向 OMNI_CDP_ENDPOINT', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brow-avail-'));
  try {
    const tool = new BrowserScreenshotTool(
      dir,
      () => new ThrowingSession(new Error('CDP WebSocket 已关闭')),
    );
    const result = await tool.handle(call({ url: 'https://example.com' }), ctx(dir));
    assert.strictEqual(result.ok, false);
    assert.match(result.error ?? '', /网页截图失败（CDP 端点不可达）/);
    assert.match(result.error ?? '', /OMNI_CDP_ENDPOINT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('失败文案：超时 ⇒ 标签 + 超时建议；未知失败保留原文案', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brow-avail-'));
  try {
    const timeoutTool = new BrowserScreenshotTool(
      dir,
      () => new ThrowingSession(new Error('浏览器未在 30000ms 内上报 DevTools 端点')),
    );
    const timed = await timeoutTool.handle(call({ url: 'https://example.com' }), ctx(dir));
    assert.match(timed.error ?? '', /网页截图失败（浏览器无响应或探测超时）/);

    const otherTool = new BrowserScreenshotTool(
      dir,
      () => new ThrowingSession(new Error('截图写入磁盘失败')),
    );
    const other = await otherTool.handle(call({ url: 'https://example.com' }), ctx(dir));
    assert.match(other.error ?? '', /^网页截图失败: 截图写入磁盘失败$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** 构造一条 browser_screenshot 调用。 */
function call(args: Record<string, unknown>): ToolCall {
  return { id: 'c1', name: 'browser_screenshot', arguments: args };
}

/** 构造工具上下文。 */
function ctx(root: string): ToolContext {
  return { sessionId: 's1', workspaceRoot: root };
}
