/**
 * browser_screenshot 单测（P2-⑬ 产品化）：图片经 ToolResult.files 附件通道、落盘路径约束、参数校验、失败不抛。
 *
 * 真机 e2e 单独成测，无浏览器时 `t.skip`，避免污染其它机器；本机（装有 Chrome/Edge）会真起 headless 截一张图。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserScreenshotTool } from '../../src/adapters/tool/browser/browserScreenshotTool.js';
import type { ScreenshotSession } from '../../src/adapters/tool/browser/browserScreenshotTool.js';
import type {
  ScreenshotRequest,
  ScreenshotResult,
} from '../../src/adapters/browser/browserSession.js';
import { ChromeLocator } from '../../src/adapters/browser/chromeLocator.js';
import type { ToolCall, ToolContext } from '../../src/ports/tool/tool.js';

/** 最小合法 PNG 字节（IHDR 报 8×4），用于假会话返回。 */
const FAKE_PNG = ((): Buffer => {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(8, 16);
  buffer.writeUInt32BE(4, 20);
  return buffer;
})();

/** 记录调用入参的假会话（不真起浏览器）。 */
class FakeSession implements ScreenshotSession {
  /** 最近一次收到的截图请求（供断言参数夹紧）。 */
  public lastRequest: ScreenshotRequest | undefined;
  /** close 是否被调用。 */
  public closed = false;
  /** 置位后 screenshot 抛错（模拟真实失败）。 */
  public failWith: Error | undefined;

  /**
   * 假截图：记录请求并回一张最小 PNG；置位 failWith 时抛错。
   *
   * @param request 截图请求
   * @returns 固定尺寸/标题的截图结果
   */
  public async screenshot(request: ScreenshotRequest): Promise<ScreenshotResult> {
    if (this.failWith !== undefined) {
      throw this.failWith;
    }
    this.lastRequest = request;
    return {
      png: FAKE_PNG,
      width: request.width,
      height: request.height,
      finalUrl: request.url,
      title: 'Fake Title',
    };
  }

  /**
   * 假关闭：只置位。
   *
   * @returns 无
   */
  public async close(): Promise<void> {
    this.closed = true;
  }
}

/** 用假会话建工具。 */
const makeTool = (root: string, session: FakeSession): BrowserScreenshotTool =>
  new BrowserScreenshotTool(root, () => session);

const call = (args: Record<string, unknown>): ToolCall => ({
  id: 'c1',
  name: 'browser_screenshot',
  arguments: args,
});
const ctx = (root: string): ToolContext => ({ sessionId: 's1', workspaceRoot: root });

test('url 缺省 / 协议非法 → ok:false（不抛）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'browshot-'));
  try {
    const session = new FakeSession();
    const tool = makeTool(dir, session);

    const none = await tool.handle(call({}), ctx(dir));
    assert.strictEqual(none.ok, false);
    assert.match(none.error ?? '', /缺少 url/);

    const bad = await tool.handle(call({ url: 'ftp://example.com' }), ctx(dir));
    assert.strictEqual(bad.ok, false);
    assert.match(bad.error ?? '', /仅 http\/https\/data/);
    assert.strictEqual(session.lastRequest, undefined, '非法请求不应落到会话');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('视口/等待参数被夹紧到合规区间，缺省用默认', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'browshot-'));
  try {
    const session = new FakeSession();
    const tool = makeTool(dir, session);
    await tool.handle(
      call({ url: 'https://example.com', width: 10, height: 99999, wait_ms: -5 }),
      ctx(dir),
    );
    assert.strictEqual(session.lastRequest?.width, 64, '过小 → 下界 64');
    assert.strictEqual(session.lastRequest?.height, 4096, '过大 → 上界 4096');
    assert.strictEqual(
      session.lastRequest?.waitMs,
      BrowserScreenshotTool.DEFAULT_WAIT_MS,
      '负值 → 默认 500',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('output_path 缺省写入 .omniharness/screenshots/，且相对路径须落在工作区内', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'browshot-'));
  try {
    const session = new FakeSession();
    const tool = makeTool(dir, session);
    const result = await tool.handle(call({ url: 'https://example.com' }), ctx(dir));
    assert.strictEqual(result.ok, true);
    assert.match(result.output ?? '', /\.omniharness\/screenshots\//, '缺省落盘位置');
    assert.strictEqual(result.files?.[0]?.mediaType, 'image/png');
    assert.ok((result.files?.[0]?.data ?? '').length > 0, 'base64 不得为空');

    const escaped = await tool.handle(
      call({ url: 'https://example.com', output_path: '../escape.png' }),
      ctx(dir),
    );
    assert.strictEqual(escaped.ok, false);
    assert.match(escaped.error ?? '', /路径越界/);

    const abs = await tool.handle(
      call({ url: 'https://example.com', output_path: 'C:\\x.png' }),
      ctx(dir),
    );
    assert.strictEqual(abs.ok, false);
    assert.match(abs.error ?? '', /相对工作区/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('显式 output_path 落到工作区并使文件真实存在', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'browshot-'));
  try {
    const session = new FakeSession();
    const tool = makeTool(dir, session);
    const result = await tool.handle(
      call({ url: 'https://example.com', output_path: 'out/shot.png' }),
      ctx(dir),
    );
    assert.strictEqual(result.ok, true);
    assert.ok(existsSync(join(dir, 'out', 'shot.png')), '文件应被真正写出');
    const bytes = await readFile(join(dir, 'out', 'shot.png'));
    assert.strictEqual(bytes[0], 0x89, 'PNG 魔数');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('会话失败 → ok:false（不抛），关闭时回收会话', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'browshot-'));
  try {
    const session = new FakeSession();
    session.failWith = new Error('DevTools 端口未在预期时间内就绪');
    const tool = makeTool(dir, session);
    const result = await tool.handle(call({ url: 'https://example.com' }), ctx(dir));
    assert.strictEqual(result.ok, false);
    assert.match(result.error ?? '', /网页截图失败/);
    await tool.close();
    assert.strictEqual(session.closed, true, 'close 要回收浏览器会话');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('真机 e2e：用本机 Chrome 截一张 data: 页面（无浏览器则跳过）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'browshot-e2e-'));
  try {
    const chrome = ChromeLocator.locate();
    if (chrome.executable === null) {
      // 没有浏览器 ⇒ 跳过，而非失败（其它机器不应因缺 Chrome 而红）。
      return;
    }
    const tool = new BrowserScreenshotTool(dir); // 默认工厂起真实 headless 浏览器
    const result = await tool.handle(
      {
        id: 'c1',
        name: 'browser_screenshot',
        arguments: {
          url: 'data:text/html,<h1 style="background:%23c00">x</h1>',
          width: 800,
          height: 600,
        },
      },
      ctx(dir),
    );
    assert.strictEqual(result.ok, true, `真机截图失败：${result.error ?? ''}`);
    const data = result.files?.[0]?.data ?? '';
    const decoded = Buffer.from(data, 'base64');
    assert.strictEqual(decoded[0], 0x89, 'PNG 魔数');
    assert.strictEqual(decoded[1], 0x50);
    assert.ok((result.output ?? '').includes('800×600'), '输出应含视口尺寸');
    await tool.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
