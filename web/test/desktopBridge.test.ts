import { afterEach, describe, expect, test } from 'vitest';
import {
  desktopBridge,
  notifyDesktop,
  type DesktopNotifyInput,
} from '../src/core/desktop/DesktopBridge.ts';

interface FakeOmni {
  apiVersion: number;
  notify: (input: DesktopNotifyInput) => Promise<unknown>;
  onNotificationClick: (listener: (sessionId: string | undefined) => void) => () => void;
  onDeepLink: (listener: (url: string) => void) => () => void;
}

/** 删除全局桥（每个用例后清理，避免污染）。 */
function clearOmni(): void {
  delete (globalThis as { omni?: unknown }).omni;
}

afterEach(clearOmni);

describe('DesktopBridge', () => {
  test('浏览器环境没有 window.omni 时返回 null 且 notify 为 no-op', () => {
    expect(desktopBridge()).toBeNull();
    expect(() => notifyDesktop({ title: 'x', body: 'y' })).not.toThrow();
  });

  test('结构不合法（版本/方法缺失）时 fail-safe 返回 null', () => {
    (globalThis as { omni?: unknown }).omni = { apiVersion: 1, notify: () => Promise.resolve() };
    expect(desktopBridge()).toBeNull();
  });

  test('合法桥：notify 透传输入，订阅函数可取消', async () => {
    const calls: DesktopNotifyInput[] = [];
    let unsubscribeCount = 0;
    const fake: FakeOmni = {
      apiVersion: 1,
      notify: (input) => {
        calls.push(input);
        return Promise.resolve(true);
      },
      onNotificationClick: () => () => {
        unsubscribeCount += 1;
      },
      onDeepLink: () => () => {
        unsubscribeCount += 1;
      },
    };
    (globalThis as { omni?: unknown }).omni = fake;
    const bridge = desktopBridge();
    expect(bridge).not.toBeNull();
    notifyDesktop({ title: 't', body: 'b', sessionId: 's' });
    await Promise.resolve();
    expect(calls).toEqual([{ title: 't', body: 'b', sessionId: 's' }]);
    const offA = bridge?.onNotificationClick(() => {});
    const offB = bridge?.onDeepLink(() => {});
    offA?.();
    offB?.();
    expect(unsubscribeCount).toBe(2);
  });
});
