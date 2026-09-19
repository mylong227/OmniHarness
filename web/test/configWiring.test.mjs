// F5 配置 UI 收敛：SettingsTab ↔ config.get / config.update 接线契约测试。
// 验证「改动落盘 → 重新拉取配置回填 → 相关状态（厂商目录）刷新」闭环在 UI 侧成立，
// 以及三处配置入口（适配器下拉 / 模型名 / base-url）都走 config.update。
// 直跑 web/dist（web:build 编译后），node --test web/test/*.test.mjs。

import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntime } from './hooksStub.mjs';

const runtime = createRuntime();
runtime.install();
const { SettingsTab } = await import('../dist/ui/components/tabs/SettingsTab.js');

/** 让排队的 promise 全部落地。 */
async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

/** 深度收集满足谓词的节点（能进 map 产生的嵌套数组）。 */
function collect(vnode, pred, out = []) {
  if (Array.isArray(vnode)) {
    for (const k of vnode) collect(k, pred, out);
    return out;
  }
  if (vnode == null || typeof vnode !== 'object') return out;
  if (pred(vnode)) out.push(vnode);
  collect(vnode.children, pred, out);
  return out;
}

/**
 * 安装配置 API 桩并渲染一次 SettingsTab。
 * @returns vnode 与调用记录
 */
function renderSettings() {
  const calls = { updates: [], getConfig: 0, catalog: 0, toasts: [] };
  let lastCfg = null;
  runtime.appContext.api = {
    async getConfig() {
      calls.getConfig += 1;
      lastCfg = {
        model: 'gpt-4o',
        modelAdapter: 'openai',
        approval: 'rules',
        sandbox: 'policy',
        escalation: 'deny',
        autoApprove: false,
        workspace: '/workspace',
      };
      return lastCfg;
    },
    async updateConfig(patch) {
      calls.updates.push(patch);
      return { ok: true };
    },
    async listProfiles() {
      return [{ id: 'p1', name: '默认' }];
    },
    async getActiveProfile() {
      return { plugins: ['demo'] };
    },
  };
  runtime.appContext.toast = (m, k) => calls.toasts.push({ m, k });
  runtime.appContext.refreshModelCatalog = () => {
    calls.catalog += 1;
  };
  runtime.reset();
  const vnode = runtime.render(SettingsTab, { theme: 'dark', onToggleTheme: () => {} });
  return {
    vnode,
    calls,
    cfg: () => lastCfg,
    /** 清掉组件里「已保存」提示的消隐定时器，避免挂到测试进程退出。 */
    clearHintTimer() {
      const hintRef = runtime.get(9);
      if (hintRef && hintRef.current) clearTimeout(hintRef.current);
    },
  };
}

test('SettingsTab：适配器改动落盘后重新拉取配置并刷新厂商目录', async () => {
  const { vnode, calls, cfg, clearHintTimer } = renderSettings();
  const selects = collect(vnode, (n) => n.type === 'select');
  assert.ok(selects.length >= 2, '必须渲染适配器 / 审批等下拉');

  // 第 0 个下拉是「模型适配器」（SELECTS 顺序：modelAdapter / approval / sandbox / escalation）。
  selects[0].props.onChange({ target: { value: 'anthropic' } });
  await flush();
  clearHintTimer();

  assert.deepEqual(calls.updates, [{ modelAdapter: 'anthropic' }], '适配器改动必须走 config.update');
  assert.equal(calls.getConfig, 1, '保存成功后必须重新拉取配置');
  assert.equal(calls.catalog, 1, '命中 modelAdapter 必须刷新厂商目录（模型下拉即时同步）');
  assert.deepEqual(runtime.get(0), cfg(), '重新拉取的配置必须落回组件状态（表单回填的单一来源）');
});

test('SettingsTab：审批模式改动落盘并重拉配置，但不刷新厂商目录', async () => {
  const { vnode, calls, clearHintTimer } = renderSettings();
  const selects = collect(vnode, (n) => n.type === 'select');
  selects[1].props.onChange({ target: { value: 'ask' } });
  await flush();
  clearHintTimer();

  assert.deepEqual(calls.updates, [{ approval: 'ask' }]);
  assert.equal(calls.getConfig, 1, '任何改动都要重拉配置');
  assert.equal(calls.catalog, 0, '与模型无关的改动不该刷厂商目录');
});

test('SettingsTab：模型名与自定义 base-url 均经 config.update 落盘', async () => {
  const { vnode, calls, clearHintTimer } = renderSettings();
  const inputs = collect(vnode, (n) => n.type === 'input' && n.props.type === 'text');
  assert.ok(inputs.length >= 2, '必须渲染模型名与 base-url 两个文本输入');

  inputs[0].props.onChange({ target: { value: '  gpt-4o-mini  ' } });
  await flush();
  inputs[1].props.onChange({ target: { value: ' https://example.test/v1 ' } });
  await flush();
  clearHintTimer();

  assert.deepEqual(calls.updates, [
    { model: 'gpt-4o-mini' },
    { baseUrl: 'https://example.test/v1' },
  ]);
  assert.equal(calls.getConfig, 2, '两次保存各自重拉一次配置');
  assert.equal(calls.catalog, 1, '只有模型名改动需要刷厂商目录');
});

test('SettingsTab：保存失败只提示错误，不重拉配置（避免假刷新）', async () => {
  const { vnode, calls, clearHintTimer } = renderSettings();
  runtime.appContext.api.updateConfig = async () => {
    throw new Error('config.update 拒绝');
  };
  const selects = collect(vnode, (n) => n.type === 'select');
  selects[0].props.onChange({ target: { value: 'mock' } });
  await flush();
  clearHintTimer();

  assert.deepEqual(calls.toasts, [{ m: '保存失败：config.update 拒绝', k: 'err' }]);
  assert.equal(calls.getConfig, 0, '保存失败不得重拉配置');
  assert.equal(calls.catalog, 0);
});
