import { afterEach, describe, expect, test } from 'vitest';
import {
  desktopBridge,
  notifyDesktop,
  type DesktopInfo,
  type DesktopNotifyInput,
  type DesktopUpdateStatus,
} from '../src/core/desktop/DesktopBridge.ts';

interface FakeOmni {
  apiVersion: number;
  getInfo: () => Promise<DesktopInfo>;
  setCloseToTray: (enabled: boolean) => Promise<boolean>;
  setOpenAtLogin: (enabled: boolean) => Promise<boolean>;
  openLogs: () => Promise<void>;
  restartHarness: () => Promise<void>;
  notify: (input: DesktopNotifyInput) => Promise<unknown>;
  checkForUpdates: () => Promise<void>;
  downloadUpdate: () => Promise<void>;
  installUpdate: () => Promise<void>;
  getUpdateStatus: () => Promise<DesktopUpdateStatus>;
  onUpdateStatus: (listener: (status: DesktopUpdateStatus) => void) => () => void;
  onNotificationClick: (listener: (sessionId: string | undefined) => void) => () => void;
  onDeepLink: (listener: (url: string) => void) => () => void;
}

/** 删除全局桥（每个用例后清理，避免污染）。 */
function clearOmni(): void {
  delete (globalThis as { omni?: unknown }).omni;
}

/** 构造完整假桥。 */
function fakeOmni(overrides: Partial<FakeOmni> = {}): FakeOmni {
  return {
    apiVersion: 1,
    getInfo: () =>
      Promise.resolve({
        appVersion: '0.0.0-test',
        platform: 'win32',
        workspace: 'D:\\ws',
        closeToTray: true,
        openAtLogin: false,
      }),
    setCloseToTray: (enabled) => Promise.resolve(enabled),
    setOpenAtLogin: (enabled) => Promise.resolve(enabled),
    openLogs: () => Promise.resolve(),
    restartHarness: () => Promise.resolve(),
    notify: () => Promise.resolve(true),
    checkForUpdates: () => Promise.resolve(),
    downloadUpdate: () => Promise.resolve(),
    installUpdate: () => Promise.resolve(),
    getUpdateStatus: () => Promise.resolve({ state: 'idle' }),
    onUpdateStatus: () => () => undefined,
    onNotificationClick: () => () => undefined,
    onDeepLink: () => () => undefined,
    ...overrides,
  };
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
    const fake = fakeOmni({
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
    });
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

  test('桌面设置/更新方法透传', async () => {
    const calls: string[] = [];
    (globalThis as { omni?: unknown }).omni = fakeOmni({
      setCloseToTray: (enabled) => {
        calls.push(`close:${enabled}`);
        return Promise.resolve(enabled);
      },
      setOpenAtLogin: (enabled) => {
        calls.push(`login:${enabled}`);
        return Promise.resolve(enabled);
      },
      checkForUpdates: () => {
        calls.push('check');
        return Promise.resolve();
      },
    });
    const bridge = desktopBridge();
    expect(bridge).not.toBeNull();
    await bridge?.setCloseToTray(false);
    await bridge?.setOpenAtLogin(true);
    await bridge?.checkForUpdates();
    expect(calls).toEqual(['close:false', 'login:true', 'check']);
    expect((await bridge?.getInfo())?.closeToTray).toBe(true);
  });
});
