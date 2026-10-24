// @vitest-environment jsdom
// 设置模态的装载失败判据（2026-10-23 用户报「读取厂商目录…」一直加载不出）。
//
// ## 为什么需要它
//
// 用户截图里「厂商接入」只剩一行「读取厂商目录…」；实际根因是服务端 `model.catalog` 失败
// （当时跑的是旧 serve 进程，读不了新配置键）。但旧前端把 `.catch(() => {})` 吞掉，
// 于是**读挂了**与**还在读**长得一模一样，用户只能干等。同类问题也存在于首次 `config.get`
// 失败：整页都是占位符，却没有任何报错。
//
// 本判据钉死两条恢复路径：
//   A. `model.catalog` 失败 ⇒ 显示服务端原因 + 「重试」；重试成功 ⇒ 厂商卡片出现、错误条消失。
//   B. 首次 `config.get` 失败 ⇒ 顶部显示「读取配置失败：…」+「重试」；重试成功 ⇒ 错误条消失、
//      默认模型回填。
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { fireEvent, renderFacadeAsync, waitFor } from './rtlHarness.ts';

const { SettingsModal } = await import('../src/ui/components/SettingsModal.tsx');

/** 一个最小但形状完整的厂商预设（ProviderCard 会读 label/baseUrl/models 等）。 */
const PROVIDER = {
  id: 'deepseek',
  label: 'DeepSeek',
  adapter: 'openai' as const,
  baseUrl: 'https://api.deepseek.com',
  defaultModel: 'deepseek-v4-flash',
  needsKey: true,
  models: ['deepseek-v4-flash'],
  reasoningEffort: ['high'],
};

/** 打开「模型」栏所需的最小 props。 */
const PROPS = {
  open: true,
  tab: 'model' as const,
  theme: 'light' as const,
  themePref: 'light' as const,
  locale: 'zh' as const,
  onThemePrefChange: () => {},
  onLocaleChange: () => {},
  onClose: () => {},
  onTabChange: () => {},
  onOpenPanel: () => {},
};

/**
 * 渲染设置模态，并补上设置模型会拉的三条无关 RPC（避免假 api 返回 `{}` 造成额外噪声）。
 * @param responses 需要覆盖的 api 方法
 * @returns 渲染结果
 */
async function renderSettings(responses: Record<string, unknown>) {
  return renderFacadeAsync(SettingsModal, {
    props: PROPS,
    responses: {
      listProfiles: () => Promise.resolve([]),
      getActiveProfile: () => Promise.resolve({}),
      ...responses,
    },
  });
}

/**
 * 取错误条里的「重试」按钮。
 * @param root 容器
 * @returns 按钮；找不到为 null
 */
function retryButton(root: HTMLElement): HTMLButtonElement | null {
  const errors = Array.from(root.querySelectorAll('.sp-load-error'));
  for (const box of errors) {
    const btn = Array.from(box.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').includes('重试'),
    );
    if (btn !== undefined) return btn as HTMLButtonElement;
  }
  return null;
}

test('厂商目录读取失败：显示原因与重试，重试成功后卡片出现', async () => {
  let fail = true;
  const ui = await renderSettings({
    getConfig: () => Promise.resolve({}),
    modelCatalog: () => {
      if (fail) return Promise.reject(new Error('未知配置项 providerKeysDpapi'));
      return Promise.resolve({ providers: [PROVIDER] });
    },
  });
  try {
    await waitFor(() => {
      if (!ui.container.querySelector('.sp-load-error')) throw new Error('错误条未出现');
    });
    const box = ui.container.querySelector('.sp-load-error');
    assert.ok(box !== null);
    assert.match(
      box.textContent ?? '',
      /读取厂商目录失败：未知配置项 providerKeysDpapi/,
      '必须把服务端原因原样带出来，而不是继续显示「读取厂商目录…」',
    );
    const retry = retryButton(ui.container);
    assert.ok(retry !== null, '错误条必须给「重试」入口');

    fail = false;
    fireEvent.click(retry);
    await waitFor(() => {
      if (!ui.container.querySelector('.sp-card-wrap')) throw new Error('重试后厂商卡片未出现');
    });
    assert.strictEqual(
      ui.container.querySelector('.sp-load-error'),
      null,
      '重试成功后错误条必须消失',
    );
    assert.match(ui.container.textContent ?? '', /DeepSeek/);
  } finally {
    ui.unmount();
  }
});

test('首次配置读取失败：顶部显示原因与重试，重试成功后回填并清掉错误', async () => {
  let fail = true;
  const ui = await renderSettings({
    getConfig: () => {
      if (fail) return Promise.reject(new Error('未知配置项 providerKeysDpapi'));
      return Promise.resolve({ model: 'deepseek-v4-flash' });
    },
    modelCatalog: () => Promise.resolve({ providers: [PROVIDER] }),
  });
  try {
    await waitFor(() => {
      if (!ui.container.querySelector('.sp-load-error')) throw new Error('配置错误条未出现');
    });
    const box = ui.container.querySelector('.sp-load-error');
    assert.match(box?.textContent ?? '', /读取配置失败：未知配置项 providerKeysDpapi/);
    const retry = retryButton(ui.container);
    assert.ok(retry !== null, '配置错误条必须给「重试」入口');

    fail = false;
    fireEvent.click(retry);
    await waitFor(() => {
      if (ui.container.querySelector('.sp-load-error') !== null) throw new Error('错误条未消失');
    });
    const input = ui.container.querySelector('input[aria-label="默认模型"]') as HTMLInputElement | null;
    assert.ok(input !== null);
    assert.strictEqual(input.value, 'deepseek-v4-flash', '重试成功后配置必须回填到表单');
  } finally {
    ui.unmount();
  }
});
