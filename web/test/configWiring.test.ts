// F5 配置 UI 收敛：设置模型（SettingsModel）↔ config.get / config.update 接线契约。
//
// 2026-10-17 迁移说明：本文件原先把 `SettingsTab` 组件渲染成 vnode 再模拟 onChange。
// 设置面板重构成模态后，读写逻辑搬进了 `models/SettingsModel.ts`（零 React），
// 于是这条判据**改为直接测模型**——比原先更强，因为：
//   · 原先只能测"渲染出来的第 0 个 select 是适配器"这种**位置耦合**的断言，
//     重排字段就会假红；现在按语义断言"保存哪个键、刷不刷厂商目录"。
//   · 原先那条 `runtime.get(0) === cfg()`（断言"重拉结果落回组件 state"）现在由
//     `model.getSnapshot().cfg` 直接回答——不再是"某个 hook 槽位的值"。
// 判据条目保持四条：① 适配器落盘 + 重拉 + 刷目录 ② 审批落盘 + 重拉 + 不刷目录
// ③ 模型名与 base-url 落盘（含 trim 与"留空＝清除覆盖"）④ 保存失败只提示、不重拉。
//
// 直跑 web/dist（web:build 编译后），node --test web/test/*.test.mjs。

import assert from 'node:assert/strict';
import { test, vi } from 'vitest';

const { SettingsModel, SETTINGS_FIELDS } = await import('../src/ui/models/SettingsModel.ts');

/** 让排队的 promise 全部落地（含 await 链上的多跳）。 */
async function flush() {
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** 造一份"服务端配置"桩 + 记录调用。 */
function makeDeps(overrides = {}) {
  const calls = {
    updates: [] as Record<string, unknown>[],
    getConfig: 0,
    catalog: 0,
    toasts: [] as { m: string; k: 'ok' | 'err' }[],
    applyProfile: [] as string[],
  };
  let cfg = {
    model: 'gpt-4o',
    modelAdapter: 'openai',
    approval: 'rules',
    sandbox: 'policy',
    escalation: 'deny',
    autoApprove: false,
    workspace: '/workspace',
    baseUrl: 'https://old.test/v1',
  };
  const deps = {
    async getConfig() {
      calls.getConfig += 1;
      return cfg;
    },
    async updateConfig(patch: Record<string, unknown>) {
      calls.updates.push(patch);
      // 模拟服务端落盘：把补丁并进 cfg，这样"重拉回填"拿到的是新值而不是旧值。
      cfg = { ...cfg, ...patch };
      return { ok: true };
    },
    async listProfiles() {
      return [{ id: 'p1', name: '默认' }];
    },
    async getActiveProfile() {
      return { plugins: ['demo'] };
    },
    async applyProfile(id: string) {
      calls.applyProfile.push(id);
      return { ok: true };
    },
    refreshModelCatalog: () => {
      calls.catalog += 1;
    },
    toast: (m: string, k: 'ok' | 'err') => calls.toasts.push({ m, k }),
    ...overrides,
  };
  const model = new SettingsModel(deps);
  return { model, calls, deps };
}

/** 按 key 取字段定义（测试里不写死下标）。 */
function field(key: string) {
  const f = SETTINGS_FIELDS.find((x) => x.key === key);
  assert.ok(f !== undefined, `SETTINGS_FIELDS 必须声明字段 ${key}`);
  return f;
}

test('① 适配器改动：落盘后重拉配置并刷新厂商目录', async () => {
  const { model, calls } = makeDeps();
  await model.load();
  assert.strictEqual(model.valueOf('modelAdapter'), 'openai', '首拉必须回填当前值');

  await model.saveField(field('modelAdapter'), 'anthropic');
  await flush();
  assert.deepEqual(calls.updates, [{ modelAdapter: 'anthropic' }], '适配器改动必须走 config.update');
  assert.strictEqual(calls.getConfig, 2, '首拉 1 次 + 保存后重拉 1 次');
  assert.strictEqual(calls.catalog, 1, '命中 modelAdapter 必须刷新厂商目录（模型下拉即时同步）');
  assert.strictEqual(model.valueOf('modelAdapter'), 'anthropic', '重拉结果必须落回快照');
  model.dispose();
});

test('② 审批模式改动：落盘并重拉，但不刷厂商目录', async () => {
  const { model, calls } = makeDeps();
  await model.load();
  await model.saveField(field('approval'), 'ask');
  await flush();
  assert.deepEqual(calls.updates, [{ approval: 'ask' }]);
  assert.strictEqual(calls.getConfig, 2, '任何改动都要重拉配置');
  assert.strictEqual(calls.catalog, 0, '与模型无关的改动不该刷厂商目录');
  model.dispose();
});

test('③ 模型名与自定义 base-url 落盘：trim + 留空即清除覆盖', async () => {
  const { model, calls } = makeDeps();
  await model.load();

  await model.saveField(field('model'), '  gpt-4o-mini  ');
  await flush();
  await model.saveField(field('baseUrl'), ' https://example.test/v1 ');
  await flush();
  assert.deepEqual(calls.updates, [
    { model: 'gpt-4o-mini' },
    { baseUrl: 'https://example.test/v1' },
  ]);
  assert.strictEqual(calls.getConfig, 3, '首拉 1 次 + 两次保存各一次');
  assert.strictEqual(calls.catalog, 1, '只有模型名改动需要刷厂商目录');

  // base-url 留空必须是**显式清除**（null），不是 no-op（undefined）也不是空串。
  await model.saveField(field('baseUrl'), '   ');
  await flush();
  assert.deepEqual(calls.updates[2], { baseUrl: null }, '留空＝清除覆盖，服务端约定 null');
  model.dispose();
});

test('④ 保存失败：只提示错误，不重拉配置（避免假刷新）', async () => {
  const { model, calls, deps } = makeDeps();
  await model.load();
  deps.updateConfig = async () => {
    throw new Error('config.update 拒绝');
  };

  await model.saveField(field('modelAdapter'), 'mock');
  await flush();
  assert.deepEqual(calls.toasts, [{ m: '保存失败：config.update 拒绝', k: 'err' }]);
  assert.strictEqual(calls.getConfig, 1, '保存失败不得重拉配置（否则表单会被回填成旧值）');
  assert.strictEqual(calls.catalog, 0);
  assert.ok(model.getSnapshot().error !== '', '失败文案必须进快照（模态顶部要显示）');
  model.dispose();
});

test('⑤ 开关字段按布尔落盘（autoApprove）', async () => {
  const { model, calls } = makeDeps();
  await model.load();
  assert.strictEqual(model.boolOf('autoApprove'), false, '首拉回填开关态');
  await model.saveField(field('autoApprove'), true);
  await flush();
  assert.deepEqual(calls.updates, [{ autoApprove: true }]);
  assert.strictEqual(model.boolOf('autoApprove'), true);
  model.dispose();
});

test('⑥ 配置集应用：走 profile.apply 并刷新生效插件回显', async () => {
  const { model, calls } = makeDeps();
  await model.load();
  assert.strictEqual(model.getSnapshot().activePlugins, 'demo');
  await model.applyProfile('p1');
  await flush();
  assert.deepEqual(calls.applyProfile, ['p1']);
  assert.strictEqual(model.getSnapshot().profiles.length, 1);
  model.dispose();
});

test('⑦ 「已保存」提示会自动消隐（dispose 后不再有挂起定时器）', async () => {
  // 只 fake setTimeout：flush() 用的是 setImmediate，仍需真实执行。
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  try {
    const { model } = makeDeps();
    await model.load();
    let notified = 0;
    const unsub = model.subscribe(() => {
      notified += 1;
    });
    await model.saveField(field('approval'), 'auto');
    await flush();
    assert.strictEqual(model.getSnapshot().savedHint, '已保存', '保存成功后闪现提示');
    model.dispose();
    notified = 0;
    await vi.advanceTimersByTimeAsync(2000);
    assert.strictEqual(notified, 0, 'dispose 之后不该再有通知（订阅已清、迟到定时器也不得回写）');
    unsub();
  } finally {
    vi.useRealTimers();
  }
});
