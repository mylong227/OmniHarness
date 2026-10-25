// @vitest-environment jsdom
// 设置 → 桌面栏：浏览器降级、桌面信息读取、开关透传。
import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DesktopSettingsSection } from '../src/ui/components/settings/DesktopSettingsSection.tsx';

/** 删除全局桥。 */
function clearOmni(): void {
  delete (globalThis as { omni?: unknown }).omni;
}

afterEach(() => {
  cleanup();
  clearOmni();
});

/** 完整假桥（与 preload 形状一致）。 */
function fakeOmni(calls: string[]): Record<string, unknown> {
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
    setCloseToTray: (enabled: boolean) => {
      calls.push(`close:${enabled}`);
      return Promise.resolve(enabled);
    },
    setOpenAtLogin: (enabled: boolean) => {
      calls.push(`login:${enabled}`);
      return Promise.resolve(enabled);
    },
    openLogs: () => Promise.resolve(),
    restartHarness: () => Promise.resolve(),
    notify: () => Promise.resolve(true),
    checkForUpdates: () => {
      calls.push('check');
      return Promise.resolve();
    },
    downloadUpdate: () => Promise.resolve(),
    installUpdate: () => Promise.resolve(),
    getUpdateStatus: () => Promise.resolve({ state: 'idle' }),
    onUpdateStatus: () => () => undefined,
    onNotificationClick: () => () => undefined,
    onDeepLink: () => () => undefined,
  };
}

describe('DesktopSettingsSection', () => {
  test('浏览器模式显示降级说明，不渲染开关', () => {
    render(<DesktopSettingsSection />);
    expect(screen.getByText('桌面')).toBeTruthy();
    expect(screen.getByText(/浏览器模式/)).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
  });

  test('桌面模式读取信息，开关透传并更新界面', async () => {
    const calls: string[] = [];
    (globalThis as { omni?: unknown }).omni = fakeOmni(calls);
    render(<DesktopSettingsSection />);
    expect(await screen.findByText('0.0.0-test')).toBeTruthy();
    const switches = screen.getAllByRole('switch');
    expect(switches).toHaveLength(2);
    fireEvent.click(switches[0]!);
    await waitFor(() => expect(calls).toContain('close:false'));
    expect(screen.getAllByText('已关闭').length).toBeGreaterThan(0);
    fireEvent.click(switches[1]!);
    await waitFor(() => expect(calls).toContain('login:true'));
  });
});
