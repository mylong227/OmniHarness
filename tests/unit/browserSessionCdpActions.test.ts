/** BrowserSession 的 CDP 动作回退判据（2026-10-21）。 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { BrowserSession } from '../../src/adapters/browser/browserSession.ts';
import type { ChromeProcessLike } from '../../src/adapters/browser/browserSession.ts';
import { CdpClient } from '../../src/adapters/browser/cdpClient.ts';
import type { WebSocketLike } from '../../src/adapters/browser/cdpClient.ts';
import type {
  ChromeLaunchResult,
  ChromeProcessOptions,
} from '../../src/adapters/browser/chromeProcess.ts';
import type { ChromeLookup } from '../../src/adapters/browser/chromeLocator.ts';

interface Frame {
  readonly id?: number;
  readonly method?: string;
  readonly params?: { expression?: string };
}

class FakeSocket implements WebSocketLike {
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  public readonly methods: string[] = [];

  public addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
    if (type === 'open') {
      queueMicrotask(() => this.emit('open', {}));
    }
  }

  public send(data: string): void {
    const frame = JSON.parse(data) as Frame;
    this.methods.push(frame.method ?? '');
    const result = FakeSocket.resultOf(frame);
    this.emit('message', { data: JSON.stringify({ id: frame.id, result }) });
    if (frame.method === 'Page.navigate') {
      this.emit('message', { data: JSON.stringify({ method: 'Page.loadEventFired', params: {} }) });
    }
  }

  public close(): void {
    this.emit('close', {});
  }

  public emitEvent(method: string, params: unknown): void {
    this.emit('message', { data: JSON.stringify({ method, params }) });
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  private static resultOf(frame: Frame): unknown {
    switch (frame.method) {
      case 'Target.createTarget':
        return { targetId: 'target-1' };
      case 'Target.attachToTarget':
        return { sessionId: 'session-1' };
      case 'Runtime.evaluate': {
        const expression = frame.params?.expression ?? '';
        if (expression === 'location.href') {
          return { result: { value: 'https://final.example/' } };
        }
        if (expression.includes('document.body && document.body.innerText.includes')) {
          return { result: { value: 'FOUND' } };
        }
        return { result: { value: 'OK' } };
      }
      case 'Accessibility.getFullAXTree':
        return {
          nodes: [
            { role: { value: 'button' }, name: { value: '提交' } },
            { ignored: true, role: { value: 'generic' }, name: { value: '隐藏' } },
            { role: { value: 'textbox' }, name: { value: '名称' } },
          ],
        };
      default:
        return {};
    }
  }
}

class FakeProcess implements ChromeProcessLike {
  public kills = 0;
  public async launch(): Promise<ChromeLaunchResult> {
    return { webSocketUrl: 'ws://fake/devtools/browser/1', port: 9222 };
  }
  public kill(): void {
    this.kills += 1;
  }
}

const lookup: ChromeLookup = { executable: '/fake/chrome', searched: [] };

test('ACT-01：CDP 回退覆盖九个动作，且 console/network 观测有界可用', async () => {
  const socket = new FakeSocket();
  const client = new CdpClient({ webSocket: () => socket, timeoutMs: 2_000 });
  await client.connect('ws://fake');
  const process = new FakeProcess();
  const session = new BrowserSession({
    locate: () => lookup,
    createProcess: (_options: ChromeProcessOptions) => process,
    connectCdp: async () => client,
    loadTimeoutMs: 100,
  });
  try {
    const goto = await session.act({ kind: 'goto', url: 'https://example.com/' });
    assert.strictEqual(goto.ok, true, goto.output);
    assert.match(goto.output, /final\.example/);

    const click = await session.act({ kind: 'click', selector: '#b' });
    assert.strictEqual(click.ok, true, click.output);

    const type = await session.act({ kind: 'type', selector: '#q', text: 'hello' });
    assert.strictEqual(type.ok, true, type.output);

    const press = await session.act({ kind: 'press', key: 'Enter' });
    assert.strictEqual(press.ok, true, press.output);

    const scroll = await session.act({ kind: 'scroll', dx: 10, dy: 20 });
    assert.strictEqual(scroll.ok, true, scroll.output);

    const wait = await session.act({ kind: 'wait_for', text: '完成', timeoutMs: 500 });
    assert.strictEqual(wait.ok, true, wait.output);

    const aria = await session.act({ kind: 'aria_snapshot' });
    assert.strictEqual(aria.ok, true, aria.output);
    assert.match(aria.output, /button: 提交/);
    assert.doesNotMatch(aria.output, /隐藏/);

    socket.emitEvent('Runtime.consoleAPICalled', {
      type: 'error',
      args: [{ value: 'boom' }],
    });
    socket.emitEvent('Network.responseReceived', {
      response: { status: 500, url: 'https://example.com/api' },
    });
    const consoleResult = await session.act({ kind: 'console' });
    assert.match(consoleResult.output, /boom/);
    const network = await session.act({ kind: 'network' });
    assert.match(network.output, /500/);
  } finally {
    await session.close();
  }
  assert.strictEqual(process.kills, 1);
});
